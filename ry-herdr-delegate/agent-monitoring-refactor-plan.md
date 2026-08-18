# ry-herdr-delegate 外部 Agent 监听重构方案

> 状态：本地 runtime 已实现 `AgentTurnMonitor`、relay 前 baseline、`wait:false` formal relay、JSONL observation/reconciliation 事件和 pipeline/leaf 接入；当前仍未完成发布安装后的 live smoke，因此本文的完整完成定义尚未满足。
>
> 当前 `ry-skill@0.6.0` 已实现 shared `AgentTurnMonitor`，但仍需完成本版本的 publish、canonical install 和 live smoke。
>
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)、[repair-workflow-plan.md](./repair-workflow-plan.md)。
>
> 记录日期：2026-08-18。

## 1. 背景与结论

重构前的 pipeline/leaf delegation 监听链路把三种不同含义的信号串成了一个完成判断：

| 信号 | 实际含义 | 当前风险 |
| --- | --- | --- |
| `herdr agent prompt --wait` | Herdr 观察到 prompt 相关的状态变化或等待结束 | 被当作 child turn 已经完成 |
| `agent get` / `agent wait` 的 `idle`、`done`、`blocked` | 外部进程的 transport 状态 | 被当作语义完成状态 |
| `agent read` 中的 `STATUS`、`SUMMARY`、`VALIDATION` | child 针对当前 relay 的完成合同 | 只有前两个信号结束后才读取 |

重构前的主要路径如下：

```text
DelegateEngine.relayAndAwaitTurn
  -> HerdrCliGateway.prompt(wait: true)
  -> Herdr agent prompt --wait
  -> DelegateEngine.waitAndResolve
  -> HerdrCliGateway.waitFor
  -> captureCompletion
  -> parseCompletionContract
```

其中：

- formal task relay 使用 `prompt(wait: false)`；
- `AgentTurnMonitor` 在 relay 后独立轮询 `getAgent`/`waitFor`、terminal output 和 completion contract；
- startup session bootstrap 仍可使用受控的 `prompt(wait: true)`，但 bootstrap 不是 task completion signal；
- pipeline UI 轮询的是持久 JSONL 状态，而不是 child 的实时输出。

这会造成以下状态脱节：

1. child 仍在处理任务，但 Herdr 已返回 `idle`；
2. child 已完成，但 terminal snapshot 尚未刷新；
3. `recent-unwrapped` 中仍是 bootstrap、relay 指令或旧轮次的完成合同；
4. narrow pane 将合法标题切成多个视觉行；
5. 父端收到 `PARTIAL` 或 `ERROR` 后只能依赖后续不确定的 pane callback，无法可靠结束 monitor。

**结论：应当重构。** 但不应简单地把 callback 替换成“读取最后几行”。正确方向是：把轮询变成 authoritative observation loop，把 Herdr 的 wait/callback 降级为可选的 wake-up hint；语义完成必须由当前 relay 对应的 completion contract 和 exact session identity 共同证明。

## 2. 当前实现边界

### 2.1 Leaf delegation

当前 `DelegateEngine` 已经负责：

- 创建或复用 JSONL communication log；
- 写入 task/continuation handoff；
- 创建 child pane 和启动 Agent；
- 保存 `agent_session` checkpoint；
- 调用 Herdr prompt/wait/read；
- 解析 `DONE`、`BLOCKED`、`PARTIAL`、`ERROR`；
- 只在语义 `DONE` 后执行 pane disposition；
- 对部分 Pi session 执行 exact-session completion fallback。

这些职责继续保留。重构的 seam 应位于 relay 已写入之后、语义结果提交之前，不应把 JSONL authority、pane policy 或 coordinator fencing 重新分散到 UI 层。

### 2.2 Pipeline coordinator

当前 coordinator 的职责包括：

- 从 inbox replay pipeline request；
- 在 execution lock 下 claim ready stages；
- 写入 `stage-claimed` 和 `stage-started`；
- 在 execution lock 外执行 stage；
- 用 heartbeat 延长 reservation lease；
- 在 execution lock 下以 attempt/fence/writer fence 提交结果；
- 处理 stop、answer、recover 和 stale result。

当前 stage execution 已经不在全局 execution lock 中等待外部 Agent，结果提交仍在锁内完成。这一边界应保留。监听重构不应让 coordinator 自己解析 terminal output，而应让 pipeline stage 复用统一的 Agent monitor。

### 2.3 Parent Pi UI

pipeline UI 当前通过 `PipelineStore.readProgress()` 轮询持久 JSONL，并显示：

- pipeline status；
- current stage；
- stage role、agent、pane；
- summary。

这个方向是正确的。父 Pi 不应直接把 child pane callback 当成最终状态，也不应为 pipeline 另写一套 terminal output parser。父 UI 只需要轮询 durable projection，并在 monitor 写入 observation/result 后刷新。

## 3. 目标与非目标

### 3.1 目标

1. 使用一个可测试的 `AgentTurnMonitor` 统一监听 leaf 和 pipeline stage。
2. 将 relay submission、transport observation、terminal capture 和 semantic completion 分离。
3. 以 exact `agent_session` 三元组、pane、workspace 和 relay `messageId` 隔离每一次执行。
4. 允许 child 在启动慢、输出刷新慢或 Herdr wait 回调不稳定时继续被观察，而不是立即错误结束。
5. 将 deadline、cancel、unknown transport、missing output 和 semantic failure 明确区分。
6. 将 observation、result、retry/recovery 和 stale evidence 写入 JSONL，保证重启后可 replay。
7. 让 direct UI、pipeline UI、coordinator 和 recovery 使用同一套状态语义。
8. 保留现有 exact-session、single-writer、attempt/fence、reservation 和 pane disposition 约束。

### 3.2 非目标

- 不把 terminal 最后几行作为唯一权威来源。
- 不使用 `pane read` 取代 `agent read`；pane 是显示层，容易受到窄 pane 和布局影响。
- 不以 `idle`、`done` 或 `agent_prompt_stalled` 单独判定语义完成。
- 不取消 JSONL event log；JSONL 仍是 pipeline 状态的机器权威。
- 不允许 child 直接写 authoritative JSONL。
- 不使用 latest-session、`--last`、`--continue` 或 fresh Agent 替代 exact recovery。
- 不在本专项中自动实现完整 repair workflow；修复授权和 repair stage 继续遵循 [repair-workflow-plan.md](./repair-workflow-plan.md)。

## 4. 权威性模型

监听器需要明确区分四层证据：

| 层级 | 证据 | 可以证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| 1 | Herdr `get` | pane、workspace、Agent 名称、transport status、session identity | child 是否完成任务 |
| 2 | Herdr `read` | 当前 terminal snapshot、输出 hash、候选 completion contract | 输出一定属于当前 relay，除非通过 anchor 验证 |
| 3 | JSONL handoff | 当前 transaction、stage、relay messageId、task identity、expected session | child 已经消费了 relay |
| 4 | 解析后的 completion contract | 当前 relay 的语义结果 | pane disposition 已经成功 |

最终状态必须由组合证据决定：

```text
exact identity
+ current relay anchor
+ post-submit observation
+ parseable completion contract
= semantic result
```

Herdr 的 transport 状态只用于推进观察策略：

- `working`：继续轮询；
- `idle`：继续读取 output，不能立即判定 DONE；
- `done`：进入更积极的 capture，但仍需 completion contract；
- `blocked`：读取并解析 contract，或返回 BLOCKED；
- `unknown`：记录 unknown checkpoint，按 deadline 返回 PARTIAL；
- `closed`：目标已被 Herdr 明确报告为 closed；如果当前 relay 没有已解析的合同，返回 BLOCKED 并交给上层 exact recovery，不能创建替代 child；如果合同已经在 identity 消失前解析成功，则保留该语义结果；
- `agent_not_found`：只有在当前 exact identity 已经验证过、且 Herdr 明确报告目标消失时，才能分类为 closed。

## 5. 目标模块：AgentTurnMonitor

建议新增一个内部深模块，暂定名称：

```text
ry-herdr-delegate/agent-monitor.ts
```

它的 interface 应保持小而深。调用方不需要知道 Herdr wait、terminal reread、Pi session fallback 或 observation 去重细节。

```typescript
interface AgentTurnMonitor {
  observe(input: AgentTurnObservationInput): Promise<AgentTurnObservationResult>;
}

interface AgentTurnObservationInput {
  target: string;
  paneId: string;
  workspaceId: string;
  transactionId: string;
  stageId?: string;
  stageOccurrence?: number;
  attempt: number;
  fencingToken?: string;
  executionFence: string;
  expectedSession: SessionIdentity;
  communicationFile: string;
  relayMessageId: string;
  baseline: {
    fingerprint: string;
    length: number;
    capturedAt: string;
    source: "terminal" | "pi-session";
  };
  submittedAt: string;
  deadlineAt: string;
  owner: "parent" | "coordinator";
  signal?: AbortSignal;
}

interface AgentTurnObservationResult {
  status: "DONE" | "BLOCKED" | "PARTIAL" | "ERROR";
  transportStatus: "working" | "idle" | "done" | "blocked" | "unknown" | "closed";
  completion?: CompletionContract;
  agentSession: SessionIdentity;
  paneId: string;
  agent: string;
  relayMessageId: string;
  attempt: number;
  fencingToken?: string;
  executionFence: string;
  resultKey: string;
  observations: number;
  captureSource?: "terminal" | "pi-session";
  error?: string;
}
```

实际实现可以继续使用现有 `HerdrGateway`、`RecordStore` 和 `result.ts`。上面 interface 的重点是把复杂性藏在 monitor 内部，而不是要求 `DelegateEngine`、`PipelineCoordinator`、UI monitor 各自重复一套等待逻辑。

### 5.1 Monitor 的不变量

1. `target`、`paneId`、`workspaceId` 和 `expectedSession` 必须在第一次观察和每次后续观察中校验。
2. session 缺失、session mismatch、pane mismatch 或 workspace mismatch 不能被降级为普通 idle；只有 relay 发送前的短暂 metadata 缺失可以进入有界 `SESSION_PENDING`。
3. `relayMessageId` 必须来自刚刚成功追加并验证过的 JSONL event，且 `baseline` 必须来自 relay 前的 exact capture。
4. 同一 monitor 不得发送第二次 relay；`NOT_SENT` 重试属于同一逻辑 relay，不得创建新的 stage attempt。
5. observation 可以重复；同一 `resultKey` 只能提交一次。一个 `PARTIAL` 之后的 late completion 必须使用带 `recoverySeq` 和 `supersedesEventId` 的 `reconciliation-result`，不能伪装成第二个普通 `result`。
6. deadline 是整个 stage attempt 的总期限，output activity 不重置 deadline。
7. timeout/abort/unknown transport 保留 pane，不执行 pane disposition。
8. 只有语义 `DONE` 才允许调用 `completeDone()` 和执行 close/keep/new-tab。
9. raw child output 不进入 debug log；只记录长度、hash、attempt、fencing token、resultKey、来源和 parser 结果。

## 6. 轮询协议

### 6.1 Submission 阶段

正式 relay 发送前，monitor 必须先完成一次 exact baseline capture：

1. 通过 `agent get` 校验 target、pane、workspace 和完整 `agent_session`；
2. 通过 `agent read` 读取当前 output，计算 fingerprint、长度和时间；
3. 将这些值写入 `pre-relay-checkpoint`，并作为 `AgentTurnObservationInput.baseline` 传给 monitor；
4. baseline 无法在启动 grace 内验证时，不发送正式 relay，返回 BLOCKED 并保留可检查的 child pane。

正式 relay 发送时使用：

```text
herdr agent prompt <target> <relay-text>    # relay-text 是一个文本参数；wait: false
```

`prompt --wait` 不再作为主完成路径。Herdr gateway 必须把提交结果分类为以下三种 delivery state，而不是由普通退出码推测：

| delivery state | 定义 | 后续行为 |
| --- | --- | --- |
| `NOT_SENT` | gateway 有明确证据表明请求在到达目标前失败，且没有执行副作用 | 最多重试一次，复用同一逻辑 `relayMessageId`，追加 `relay-retry` 事件；仍失败则转为 `UNKNOWN` |
| `SENT` | Herdr 接受了请求或已无法证明请求未到达 | 写入 relay checkpoint，进入 observation；不得重发 |
| `UNKNOWN` | timeout、abort、generic non-zero、`agent_prompt_stalled` 或其他无法证明 delivery 的结果 | 不重发，继续 exact identity observation，最终按合同或 deadline 分类 |

提交成功或进入 `UNKNOWN` 后立即写入同一种 checkpoint 结构，但 `deliveryState` 必须保留实际分类：成功为 `SENT`，无法证明送达为 `UNKNOWN`。

```json
{
  "type": "checkpoint",
  "operation": "relay-submitted",
  "messageId": "msg-...",
  "deliveryState": "SENT",
  "agentSession": { "kind": "...", "source": "...", "value": "..." },
  "baselineFingerprint": "sha256:...",
  "transportStatus": "unknown"
}
```

对于 `UNKNOWN`，只将示例中的 `deliveryState` 改为 `UNKNOWN`，不得据此重发 relay。

`NOT_SENT` 的重试不创建新的 child、pane、session 或 stage attempt；如果 gateway 不能提供明确的 pre-delivery 证明，一律按 `UNKNOWN` 处理。

### 6.2 Observation 阶段

每次 poll 执行以下步骤：

1. `agent get` 获取最新 transport snapshot。
2. 验证 agent、pane、workspace 和完整 `agent_session`。
3. `agent read --source recent-unwrapped --lines <N>` 读取最近输出。
4. 计算 output fingerprint、可解析行数和 snapshot 时间。
5. 以 relay `messageId`、`baseline.fingerprint` 和当前 session 过滤旧输出；只有 fingerprint 发生变化，或 source-specific relay anchor 已验证时，才算 post-submit output。
6. 解析一个完整、连续的 completion block。
7. 若发现 semantic contract，追加唯一 result event 并结束 monitor。
8. 若没有 contract，记录状态变化或 output fingerprint 变化，然后按 interval 等待下一次 poll。

建议初始参数：

| 阶段 | 建议 interval | 建议读取范围 | 目的 |
| --- | ---: | ---: | --- |
| 启动后前 10 秒 | 250 ms | 最近 200 行 | 捕获 session、bootstrap 和第一轮输出 |
| 正常运行 | 1000 ms | 最近 500 行 | 低成本观察长任务 |
| transport 已 settled 但无合同 | 250 ms | 最近 500 行 | 等待 terminal flush |
| deadline 前最后阶段 | 250 ms | 最近 500 行 | 完成最后一次 capture，不延长 deadline |

这些是 v1 的默认值，最终应由配置和测试 fixture 验证。interval 不应通过无限增加读取次数来绕过总 deadline。

### 6.3 完成判定

以下条件同时满足时，才允许产生 semantic result：

```text
current exact session matches expected session
+ current pane/workspace matches
+ output is observed after relay submission
+ parser finds one coherent completion block
+ STATUS is one of DONE/BLOCKED/PARTIAL/ERROR
```

`STATUS: DONE|BLOCKED|PARTIAL|ERROR` 这种 relay instruction 中的字面量不能被选为真实状态。parser 必须选择当前 relay 之后的有效 block，并继续要求对应的 `SUMMARY` 和 `VALIDATION` 结构符合合同。

### 6.4 Narrow pane 与 session fallback

`recent-unwrapped` 仍然是第一观察来源，但不能假设显示行一定等于 child 原始输出：

- narrow pane 可能把 `STATUS` 拆为 `STAT` 和 `US`；
- TUI 可能加入一到两个 decoration prefix；
- 旧 relay instruction 可能仍在最近输出范围内；
- Codex/Claude 的 session identity 是 id，不一定能直接读取本地 session 文件。

因此：

- Pi 使用 exact absolute JSONL session fallback；
- Codex/Claude 先使用同一 exact session 下的 terminal tail reread；
- 如果没有可验证的 agent-specific session file fallback，不能将缺少合同的输出猜测为 DONE；
- fallback 只能在 primary terminal reread 失败后运行，且不得重新发送 relay 或创建 replacement child。

## 7. 状态机

AgentTurnMonitor 内部建议使用以下状态：

```text
CREATED
  -> SESSION_PENDING       # 仅限 relay 前的 bounded startup metadata grace
  -> RELAY_SUBMITTED
  -> OBSERVING
      -> RUNNING
      -> SETTLED_WITHOUT_CONTRACT
      -> SEMANTIC_DONE
      -> SEMANTIC_BLOCKED
      -> SEMANTIC_PARTIAL
      -> SEMANTIC_ERROR
      -> IDENTITY_BLOCKED
      -> UNKNOWN_TRANSPORT
      -> CLOSED
      -> DEADLINE_PARTIAL
```

`SESSION_PENDING` 只能发生在正式 relay 之前；超过 startup grace 仍没有完整 `agent_session` 时转为 `IDENTITY_BLOCKED`。`CLOSED` 表示 exact session 已验证后目标消失，且当前 relay 没有可解析合同；它映射为 BLOCKED，供上层决定是否进行 exact recovery。

对外映射：

| Monitor 状态 | DelegateResult | pane 处理 |
| --- | --- | --- |
| `SEMANTIC_DONE` | `DONE` | 执行配置的 disposition |
| `SEMANTIC_BLOCKED` | `BLOCKED` | 保留 pane |
| `SEMANTIC_PARTIAL` | `PARTIAL` | 保留 pane |
| `SEMANTIC_ERROR` | `ERROR` | 保留 pane |
| `IDENTITY_BLOCKED` | `BLOCKED` | 保留 pane，不恢复替代 child |
| `CLOSED` | `BLOCKED` | 保留原 identity，不执行 disposition；由上层授权 exact recovery |
| `UNKNOWN_TRANSPORT` | `PARTIAL` | 保留 pane，允许后续 exact reconciliation |
| `DEADLINE_PARTIAL` | `PARTIAL` | 保留 pane，不重发 relay |
| `SETTLED_WITHOUT_CONTRACT` | 继续观察 | 不执行 disposition |

`SESSION_PENDING` 是 relay 前的内部状态，不产生 `DelegateResult`；`CLOSED` 只有在 exact session 先前已验证且当前 relay 没有合同的情况下才成立。

这里的 `ERROR`、`PARTIAL` 规则是重构后的目标行为，但本地 dirty runtime 已开始执行该规则：monitor 在 capture budget 用尽且没有合同后返回 PARTIAL；明确 transport error 或有效的 `STATUS: ERROR` completion contract 才返回 ERROR。发布安装后的 live smoke 仍是未完成验证。

## 8. JSONL observation 事件

JSONL 仍然是 parent/coordinator 的唯一写入 authority。monitor 不应直接把完整 output 写进 event log。

建议增加或复用以下事件：

| event type | 用途 | 关键字段 |
| --- | --- | --- |
| `pre-relay-checkpoint` | relay 前的 exact identity 和 baseline capture | `agentSession`, `paneId`, `baselineFingerprint`, `observedAt` |
| `relay-retry` | 明确 `NOT_SENT` 的同一逻辑 relay 重试 | `relayMessageId`, `submitAttempt`, `deliveryState` |
| `monitor-recovered` | coordinator 重启后接管同一逻辑 monitor（后续阶段事件） | `resultKey`, `owner`, `lease`, `fence`, `recoverySeq` |
| `checkpoint` | relay、transport、session 和观察检查点 | `operation`, `deliveryState`, `transportStatus`, `agentSession`, `paneId`, `baselineFingerprint`, `observedAt` |
| `observation` | output/status 发生变化 | `relayMessageId`, `outputHash`, `outputLength`, `readAttempt`, `captureSource`, `transportStatus` |
| `result` | 一个逻辑 attempt 的唯一普通结果 | `resultKey`, `status`, `summary`, `validation`, `relayMessageId`, `agentSession`, `attempt`, `fencingToken`, `executionFence`, `captureSource` |
| `reconciliation-result` | 在 PARTIAL 后对同一 relay 的有界 late completion | `resultKey`, `recoverySeq`, `supersedesEventId`, `status`, `relayMessageId`, `agentSession` |
| `error` | 明确错误或日志损坏 | `failureClass`, `errorCode`, `retryable`, `agentSession` |
| `pane-disposition` | 语义 DONE 后的 pane 操作 | `policy`, `tabLabel`, `paneId`, `tabId` |

当前 vertical slice 已实现 `pre-relay-checkpoint`、`relay-retry`、`checkpoint`、`observation`、`result` 和 `reconciliation-result`；`monitor-recovered` 仅作为 coordinator 重启接管阶段的 schema 预留，尚未由 runtime 发出。

每个执行都必须计算稳定的 `resultKey`：

```text
transactionId
+ stageId or direct-leaf marker
+ stageOccurrence
+ attempt
+ executionFence
+ relayMessageId
```

`executionFence` 对 coordinator stage 来自 writer/owner fence，对 direct leaf 来自 parent execution owner epoch；`fencingToken` 仍作为 stage reservation 的独立提交校验。

普通 `result` 在 `resultKey` 下幂等；相同 key 的相同 payload 视为 replay，冲突 payload 必须拒绝。`reconciliation-result` 只能在原结果为 PARTIAL、exact pane/workspace/session 仍一致、没有新的 stop/attempt/fence 后写入，并且必须递增 `recoverySeq`、引用 `supersedesEventId`。已经是 DONE、STOPPED 或新 attempt 的结果不可被 late observation 覆盖。

`observation` 只在下列情况追加，避免长任务每秒产生无意义的 JSONL 增长：

- transport status 变化；
- pane/session identity 变化；
- output fingerprint 变化；
- parser 从无合同变成候选合同；
- deadline、cancel 或 unknown 状态变化。

每次 append 仍必须进行 read-after-write 验证，事件必须保持单 writer、物理行范围和 idempotency 约束。

coordinator 重启或 late reconciliation 时，必须先取得对应的 coordinator execution lock 和 communication-file sidecar lock，再 replay 当前 log。只有确认旧 owner 的 lease/fence 已失效后，才能写入 `monitor-recovered` 或 `reconciliation-result`；锁、owner 和 fence 无法确认时返回 BLOCKED，不启动第二个 monitor。replay 若已找到相同 `resultKey` 的结果，只返回既有结果并追加必要的 observation diagnostic，不再次提交普通 result。

## 9. Pipeline 集成

### 9.1 Coordinator 责任

`PipelineCoordinator` 继续负责：

1. claim ready stage；
2. 写入 `stage-claimed`、`stage-started` 和 RUNNING metadata；
3. 创建或复用 stage communication file；
4. 由 `DelegateEngine` 创建 `AgentTurnMonitor`，传入 stage 的 transaction、exact identity、attempt、fencing token、execution fence、baseline、deadline 和 relay messageId；
5. 在 execution lock 外等待 monitor；
6. monitor 返回后在 execution lock 内提交 result；
7. 校验 attempt、fencing token、writer fence 和 stop state；
8. 释放 reservation 或写入 stale/cancelled diagnostic。

Coordinator 不应：

- 自己解析 `recent-unwrapped`；
- 根据 `idle` 或 `done` 直接更新 stage 为 DONE；
- 在 parent Pi 中复制一套 child output capture；
- 通过 callback 直接改变 authoritative pipeline state。

### 9.2 Parent Pi 责任

Parent Pi 只做：

- pipeline submit；
- bounded accepted polling；
- `PipelineStore.readProgress()` UI polling；
- answer/stop/recover control；
- 最终状态和 sanitized summary 展示。

Parent Pi 不需要知道 monitor 当前是第几次读取 terminal，也不需要直接读取 child pane。

### 9.3 Coordinator tick 的返回语义

v1 可以继续让一次 `pipeline.coordinator` tick 等待已 claim stage 完成，但 monitor 必须是该等待的唯一观察实现。后续如果需要真正 non-blocking scheduler，可以把 monitor 生命周期持久化为 stage run，并让 coordinator session 通过下一次 tick 继续 replay；这属于第二阶段，不应在第一阶段同时改变 scheduler 和监听语义。

无论 tick 是否同步等待，JSONL 都必须先写入 RUNNING，所以父 Pi UI 可以在 child 长时间运行时显示真实的 RUNNING/current stage，而不是等待一个最终 callback 才首次出现状态。

## 10. Direct UI 集成

当前 direct monitor 主要轮询 `getAgent`，并在 `PARTIAL` 时尝试 late reconciliation。重构后它应复用 `AgentTurnMonitor` 的 observation 语义：

- `RUNNING`：显示 spinner 和 agent/pane；
- transport settled 但没有合同：继续显示 LISTENING，不清除；
- semantic DONE：追加最终 transcript conclusion，清除 footer/widget；
- PARTIAL deadline：显示 PARTIAL，并启动有界 exact-session late observation；
- late DONE：追加 reconciliation result，停止 monitor，执行一次 disposition；
- identity mismatch/unknown：停止自动恢复，但保留明确的 BLOCKED/PARTIAL 结论。

monitor 必须具备 terminal cleanup：

- semantic terminal result 后停止 timer；
- pane closure 或 identity loss 后停止 timer；
- workspace/session 被替换后清除 parent surface；
- 不因一次 transient `getAgent` 错误清除仍可验证的 child。

## 11. 错误与控制语义

### 11.1 `agent_prompt_stalled`

`agent_prompt_stalled` 不能直接表示成功，也不能直接表示失败：

1. 记录 prompt observation；
2. 立即通过 exact `getAgent` 和 `readAgent` 开始 monitor；
3. 如果 session/pane/workspace 一致，继续观察；
4. 如果 deadline 内出现当前 relay 合同，按合同结束；
5. 如果 deadline 到期且没有合同，返回 PARTIAL，保留 child。

禁止因为 stalled 直接重发 relay。重发有副作用的任务可能导致重复修改。

### 11.2 `idle`

`idle` 只是当前 transport 没有活动 turn。只有在以下条件同时成立时，才可以结束当前 stage：

- exact session 未变化；
- relay 之后出现了新的有效 output fingerprint；
- 当前 relay 的 completion contract 已解析成功。

### 11.3 timeout/abort

- timeout 是整体 stage deadline 过期；
- abort 是 parent/coordinator 显式取消；
- 两者均返回 PARTIAL，并保留 pane；
- 不执行 wait、capture 或 disposition 的越权操作；
- 后续 reconciliation 只能复用原 communication、pane、agent 和 session。

### 11.4 stop/fail-fast

Coordinator 的 control poll 仍使用 AbortController 取消 active monitor：

- stop 后所有晚到 result 必须被 fencing 为 stale 或 STOPPED；
- fail-fast 只取消同 pipeline 的 sibling stage；
- 取消结果不能覆盖已持久化的 STOPPED；
- reservation heartbeat/release 必须使用 reservation identity 和 owner epoch 防止过期 worker 续租。

## 12. 测试矩阵

### 12.1 Monitor unit tests

| 场景 | 期望 |
| --- | --- |
| `prompt(wait)` 返回 idle，但后续 tail 出现 DONE | DONE，不重发 relay |
| `agent_prompt_stalled`，exact session 仍一致，后续出现合同 | 按 `UNKNOWN` 继续同一 session 观察，最终接受当前 relay 的合同 |
| relay 前 baseline 读取失败 | BLOCKED，不发送正式 relay，不创建新的 stage attempt |
| `NOT_SENT` 提交失败 | 最多用同一 `relayMessageId` 重试一次 |
| `UNKNOWN` 提交失败 | 不重发，继续同一 exact session 观察 |
| 正式 relay 前 exact session 缺失但仍在 startup grace 内 | 保持 `SESSION_PENDING`，不发送正式 relay |
| exact session 已验证后目标 closed 且无合同 | BLOCKED，保留 pane，交给上层 exact recovery |
| `agent get` 先 idle，output 第 N 次读取才刷新 | 继续观察，不提前 ERROR |
| relay instruction 含 `STATUS: DONE|BLOCKED|PARTIAL|ERROR` | 保持已有 relay-literal 排除行为，并覆盖回归 |
| tail 中有旧轮次 DONE，新 relay 没有合同 | 不接受旧结果 |
| narrow pane 将标题切碎 | 走重读或适用 fallback，不猜测 DONE |
| session mismatch | BLOCKED，不 wait、不 capture、不 disposition |
| pane/workspace mismatch | BLOCKED，保留原 record |
| agent_not_found | 明确 closed 时分类，否则 UNKNOWN/PARTIAL |
| deadline 到期 | PARTIAL，保留 pane，不重发 |
| explicit cancellation | PARTIAL 或 STOPPED，晚到 result 被 fencing |
| 合法 ERROR contract | ERROR，不把缺少合同和有效 ERROR 混淆 |
| 合法 BLOCKED contract | BLOCKED，可由 answer continuation 继续 |

### 12.2 Pipeline integration tests

- stage RUNNING 在 monitor 启动前已经持久化；
- monitor 等待期间 execution lock 已释放；
- control 可以在外部 Agent 长任务期间读取并取消 stage；
- parallel ready wave 的每个 stage 使用独立 monitor、communication log、pane 和 session；
- stale attempt/fence result 不覆盖新 attempt；
- monitor 失败时 reservation 必然释放；
- coordinator 重启后先取得 execution/communication locks，replay 既有 `resultKey`，并能在 owner lease/fence 明确失效后恢复同一 monitor；
- 多个 monitor 指向同一 relay 时只允许一个普通 result，late PARTIAL completion 必须走 `reconciliation-result` 并引用被替代事件；
- pipeline UI 只通过 `readProgress()` 获得 RUNNING、DONE、PARTIAL、BLOCKED；
- answer 后原 communication/session 被复用，不创建 replacement child；
- stop 后晚到 DONE 不得把 pipeline 改回 DONE；
- `maxPipelines`、resource conflict、failed dependency 和 failFast 行为保持现有语义。

### 12.3 Herdr gateway tests

- `prompt(wait: false)` argv；
- `getAgent` identity normalization；
- `readAgent` recent-unwrapped output parsing；
- transient `agent_not_idle` reread；
- `agent_prompt_stalled` 不被误报为 semantic success；
- timeout 与 AbortSignal；
- `agent_not_found` closure classification；
- 输出 hash、长度和敏感值 redaction；
- read retry 不改变 target/session，也不重复发送 relay。

### 12.4 Live smoke

监听重构完成后，必须在发布安装的 package 上顺序执行：

| Agent | 次数 | 每次要求 |
| --- | ---: | --- |
| Pi | 3 | 长任务至少等待约 20 秒，exact Pi session，semantic DONE |
| Codex | 3 | 长任务至少等待约 20 秒，Codex session id，semantic DONE |
| Claude | 3 | 长任务至少等待约 20 秒，Claude session id，semantic DONE |

每次都检查：

- parent Pi 没有提前返回 ERROR/PARTIAL；
- child 真实执行超过启动阶段；
- monitor 通过 polling 观察到最终合同；
- JSONL 有 task、relay checkpoint、observation、result 和 pane-disposition；
- 没有重发 relay、replacement session 或错误的 latest-session fallback；
- pipeline/direct UI 在终态停止监听并显示结论；
- 测试工作目录没有非预期修改。

任何一次 live issue 都必须先形成 regression/integration test，再进行版本 bump、npm publish、canonical Pi install、runtime restart 和新一轮验证。

## 13. 分阶段实施顺序

### Phase A：已完成本地红色回归

1. 已为 `prompt(wait)`/relay delivery、后续 output 延迟刷新建立 FakeGateway 测试。
2. 已为旧 relay completion literal、stale output、narrow pane 和 exact-session mismatch 保留回归覆盖。
3. 旧链路的提前结束和误判已经由共享 monitor 接管；live smoke 仍待重新执行。

### Phase B：已完成本地 AgentTurnMonitor

1. 已新增 monitor interface 和状态机。
2. formal relay 已改为 `wait: false`。
3. `getAgent + readAgent + parser + deadline` 已进入统一 poll loop。
4. 已加入 observation 去重、JSONL checkpoint 和 output fingerprint。
5. 保留 Pi exact-session fallback，并对 Codex/Claude 保持 terminal-only 限制；live smoke 尚未重新完成。

### Phase C：已接入 DelegateEngine

1. leaf 初始任务和 continuation 均使用 monitor。
2. `waitAndResolve` 只负责把 monitor 结果转换为 `DelegateResult`。
3. `reconcilePartial` 复用 monitor 的 exact identity 和 late-capture 逻辑。
4. 只有 monitor 返回 semantic DONE 才进入 pane disposition。

### Phase D：Pipeline 接入

1. stage RUNNING metadata 继续在 claim 阶段持久化。
2. `executeClaimedStage` 通过 `DelegateEngine` 间接创建 monitor，外部等待保持在 execution lock 外。
3. result commit 继续使用 attempt/fence/writer fence。
4. control poll 取消 monitor，晚到结果通过 stale fencing 丢弃。
5. coordinator recovery 从 JSONL observation 重新开始 monitor，而不是依赖内存 callback。

### Phase E：UI、文档与发布

1. direct UI 和 pipeline UI 只消费 monitor/JSONL 派生状态。
2. 更新 README、design/plan 状态和本方案的实施状态。
3. 运行 typecheck、完整测试、package dry-pack、audit 和 smoke。
4. bump version、publish、`pi install/update npm:ry-skill`、重启 Pi。
5. 完成 Pi/Codex/Claude 各 3 次长任务验证后，才将方案标记为 implemented。

## 14. 回滚策略

如果 monitor refactor 在 live smoke 中出现问题：

1. 保留失败的 JSONL communication log、observation、debug hash 和 Herdr session identity；
2. 整体回滚 package 到上一稳定版本，不在新旧 monitor 之间混用同一 communication record；
3. 不重发已经可能送达的 relay；
4. 不创建 replacement child 来掩盖 session continuity 问题；
5. 先用旧版本完成 record 取证，再决定是否对原 session 做 explicit recovery；
6. 修复必须通过新增 regression test、version bump、publish、canonical install 和 live smoke 后才能重新启用。

回滚不读取或转换旧 Markdown record。JSONL event log 仍是新 runtime 的唯一状态 authority。

## 15. 完成定义

只有同时满足以下条件，外部 Agent 监听重构才算完成：

- semantic completion 不再依赖 `prompt --wait` 或 `agent wait` 的一次性返回；
- monitor 以 exact identity、relay anchor、post-submit output 和 completion contract 判定结果；
- Pi、Codex、Claude 的延迟输出、stale output、timeout、interruption、session mismatch 都有回归覆盖；
- pipeline stage 在外部 Agent 等待期间有持久 RUNNING 状态，并能被 control 取消或恢复；
- direct UI 和 pipeline UI 在 terminal result 后停止 monitor 并显示结论；
- JSONL observation/result 具备单 writer、幂等、物理范围和 replay 语义；
- `npm run typecheck`、完整测试、`git diff --check`、audit、packaging 全部通过；
- 发布安装后的 Pi、Codex、Claude 各完成 3 次长任务 semantic DONE；
- 文档明确区分已实施能力、提案能力、已验证事实和未解决限制。
