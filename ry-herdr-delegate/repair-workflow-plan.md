# ry-herdr-delegate 修复工作流计划

> 状态：修复工作流仍为提案；并发运行时 vertical slice 已开始实现，当前仍需完成控制/replay、崩溃恢复、live smoke 和发布前硬化。
>
> 本计划建立在当前 TypeScript extension、JSONL event log、长期 coordinator、exact `agent_session` recovery 和 pipeline UI 之上。它解决的问题是：外部 agent 在 stage 执行中出现 transport 错误、语义错误或需要人工决定时，pipeline 如何有界地继续、诊断、修复和结束，而不是无条件重复追加提示词。

## 1. 当前结论

当前 runtime 已经具备有限的继续和恢复能力，但不具备完整的自动修复工作流：

| 情况 | 当前行为 | 限制 |
| --- | --- | --- |
| `BLOCKED` | `pipeline.answer` 追加 parent continuation event，唤醒 coordinator；下一次 tick 继续原 stage | 需要人工答案；不会自动分析或修复任务 |
| `PARTIAL` | 保存 checkpoint、pane 和 exact session，等待显式 recovery | 不会自动判断是否可以安全重试 |
| `ERROR` | 写入 stage result/status，pipeline 停止该 stage | 不会自动生成诊断或修复 stage |
| exact recovery | 复用仍可验证的 pane/session，或对明确关闭的 pane 做 exact resume | identity 未知或不匹配时 fail closed |
| continuation prompt | 通过 coordinator 转发到原 stage | 当前 envelope 使用 `latest` 指针，不是精确追加 event 的物理范围 |
| 多 Agent 并发 | 当前 coordinator 已支持在一次精确 tick 内领取并并发等待有界 ready wave，并使用 workspace reservation、layout lock、lease/fence 和独立 stage log；完整 repair/concurrency 协议仍未完成 | 继续补齐控制/replay、崩溃恢复、迁移、资源冲突、UI 和 live smoke 验收 |

当前实现的边界是“保持连续性并等待明确授权”，不是“保证外部 agent 自动修好工作”。任何修复流程都必须保留 exact session、JSONL 单写者和幂等约束。

## 2. 目标与非目标

### 目标

1. 把 stage 失败区分为瞬态 transport failure、可恢复的 continuation blocker、需要诊断的任务 failure 和需要人工决定的高风险 blocker。
2. 对安全的瞬态错误提供有限次数、可审计、幂等的自动重试。
3. 对语义错误启动独立且可追踪的 repair workflow，而不是盲目重发原 prompt。
4. 允许 repair workflow 在人工批准后修复工作上下文，并继续原 stage 或启动新的 stage occurrence。
5. 让 coordinator、pipeline JSONL、Pi UI 和 `pipeline.status` 显示当前是在执行、重试、修复、等待批准还是终止。
6. 保证修复失败、超时、session 丢失和状态不确定时有明确终态，不进入无限重试。
7. 在不破坏现有 exact-session、JSONL 单写者和 coordinator 边界的前提下，支持经过显式配置和资源声明的多外部 Agent 有界并发执行与可审计监控。

### 非目标

- 不把所有错误都自动重试。
- 不使用 `--last`、`--continue`、fresh agent 或模糊 session 代替 exact-session recovery。
- 不让 child agent 直接写 authoritative pipeline JSONL；所有状态仍由 parent/coordinator 写入。
- 不允许 repair agent 绕过项目权限、工具策略、审批要求或 pipeline stop。
- 不把一次修复尝试伪装成原 stage 的同一次执行；每次 retry、repair 和 continuation 都必须有可追踪的 occurrence/attempt identity。

## 3. 设计原则

### 3.1 先分类，再决定是否追加提示词

错误发生后，coordinator 先读取最后一个有效 checkpoint/result，生成受约束的 failure classification。分类本身必须写入 JSONL，不能只存在模型上下文中。

```text
transport-transient
transport-unknown
blocked-needs-answer
semantic-task-failure
policy-or-permission-failure
repair-required
cancelled
```

只有 `transport-transient` 和已经明确授权的 continuation 才允许自动追加 prompt。`semantic-task-failure` 不得直接重复原始 task，因为原始原因通常不会因此改变。

### 3.2 继续不是保证

pipeline 可以保证：

- relay event 已持久化；
- coordinator 使用已验证的 communication file；
- stage 复用或 exact-resume 原 pane/session；
- 每次决定和结果都可从 JSONL replay；
- identity 不确定时返回 `BLOCKED`/`PARTIAL`。

pipeline 不能保证外部模型一定继续运行或一定修复任务。模型、CLI、权限、网络、用户批准和工作树状态都可能使流程进入终止状态。

### 3.3 原 stage 与 repair stage 必须隔离

repair agent 可以读取原 stage 的结构化任务、错误摘要、checkpoint 范围和允许的工作目录，但不能覆盖原 stage 的 transaction/stage occurrence。建议关系如下：

```text
pipeline transaction
  ├─ stage occurrence 1: worker        -> ERROR
  ├─ repair occurrence 1: diagnostician -> repair plan
  ├─ repair occurrence 2: worker        -> approved fix
  └─ stage occurrence 2: worker        -> continuation/retry
```

如果 repair 需要新的 agent/session，必须新建 linked communication log；只有同一 stage 的安全 continuation 才能复用原 communication file 和 exact session。

### 3.4 修复必须有界

每个 pipeline 和 stage 都必须有：

- 最大 transient retry 次数；
- 最大 repair attempt 次数；
- 每次 attempt 的 timeout 和总预算；
- 相同错误指纹的重复检测；
- 用户 stop 优先级；
- 超限后的 `FAILED`/`BLOCKED` 终态。

默认策略不能通过无限增加 prompt 次数来延长 pipeline。

## 4. 目标状态机

现有 `DONE`、`BLOCKED`、`PARTIAL`、`ERROR`、`STOPPED` 状态继续保留。新增的执行细分优先作为 stage-scoped status/event，不应破坏现有 pipeline status 读取方。

```text
QUEUED
  -> ACCEPTED
  -> RUNNING
      -> DONE
      -> BLOCKED
          -> WAITING_FOR_ANSWER
          -> CONTINUING
          -> DONE / ERROR / PARTIAL
      -> TRANSIENT_FAILURE
          -> RETRYING
          -> RUNNING
          -> PARTIAL / ERROR
      -> ERROR
          -> RECOVERY_AUTHORIZED
          -> REPAIRING
          -> WAITING_FOR_APPROVAL
          -> CONTINUING
          -> DONE / PARTIAL / ERROR
      -> STOPPED
```

建议增加以下 stage detail：

| 字段 | 作用 |
| --- | --- |
| `attempt` | 原 stage 的执行次数 |
| `retryCount` | 瞬态重试次数 |
| `repairCount` | repair workflow 次数 |
| `failureClass` | 最近一次失败分类 |
| `failureFingerprint` | 错误类型、stage、checkpoint 的稳定 hash |
| `repairOf` | 当前 repair occurrence 关联的原 stage occurrence |
| `approvalRequired` | 是否必须等待 parent 决策 |
| `lastRecoverySeq` | 最近一次有效恢复授权事件 |
| `lastAttemptSeq` | 最近一次执行尝试事件 |

对外仍可以把 `RETRYING`、`REPAIRING`、`WAITING_FOR_ANSWER` 映射为现有的 `RUNNING` 或 `BLOCKED`，但 `pipeline.status` 和 UI 必须展示 detail，避免用户只看到一个笼统的 `RUNNING`。

## 5. 三类工作流

### 5.1 瞬态 transport retry

适用：

- 明确的 Herdr `agent_pane_busy`；
- 已知的 `agent_prompt_stalled`，且当前 agent exact metadata 仍一致；
- 延迟的 terminal output capture；
- 可证明没有重复发送 relay 的短暂 gateway 失败。

流程：

1. coordinator 保存失败 checkpoint 和 `failureClass: transport-transient`。
2. 检查当前 relay 是否已经被接受；已发送的 relay 不得因重试而重复发送。
3. 在同一 exact session 可验证时执行有限重读或 wait retry。
4. 若需要重发，必须生成新的 idempotency/message identity，并记录与原 event 的关系；默认不重发有副作用的 task。
5. 超过 retry limit 后转为 `PARTIAL` 或 `ERROR`，等待显式 recovery/repair。

### 5.2 BLOCKED continuation

适用：

- 外部 agent 明确要求用户提供信息；
- 缺少业务选择或需要确认的非破坏性上下文；
- 当前工作可以在同一个 stage/session 中继续。

流程：

1. stage 写入 `BLOCKED` result，并保留 pane、agent、communication file 和 exact session。
2. parent 通过 `pipeline.answer` 追加结构化 continuation event。
3. coordinator 在安全边界读取该 event；如果当前 coordinator working/blocked，只入队并返回 `QUEUED`。
4. coordinator 以精确 event 物理范围生成 relay pointer，并调用同一 stage 的 continuation。
5. stage 继续后写入新的 checkpoint/result；不得创建无关联 replacement child。
6. answer 被消费后必须有明确的 `answerSeq` 与 `lastOutcomeSeq` 关系，避免同一答案重复执行。

### 5.3 语义错误 repair workflow

适用：

- 外部 agent 返回 `ERROR` completion contract；
- 任务执行失败但 transport/session 仍然完整；
- 同一 stage 重试原 prompt 没有足够信息解决问题；
- 需要先诊断、修改工作树或调整执行计划。

流程：

1. **冻结失败现场**：保存原 stage 的 task identity、failure result、最后 checkpoint、工作目录、git 状态摘要和 exact session identity。
2. **分类**：coordinator 将错误归类为可自动修复、需人工批准、策略/权限错误或不可恢复错误。
3. **创建 repair occurrence**：repair stage 使用独立 transaction/stage occurrence 和 linked JSONL log；relay 只携带 event 文件与精确范围，不携带未过滤的完整 child output。
4. **生成 repair plan**：repair agent 输出结构化计划，包括原因、拟修改范围、验证命令、风险、是否需要批准和预计影响。
5. **审批门**：涉及文件修改、依赖升级、权限变化、外部服务、删除或不可逆操作时，进入 `WAITING_FOR_APPROVAL`；parent 通过新的 control event 批准或拒绝。
6. **执行修复**：批准后由指定 repair stage 执行，所有修改仍在原项目 cwd 和既定 agent policy 内完成。
7. **验证修复**：运行计划中的验证命令，写入 repair result 和验证摘要；失败则增加 `repairCount`，不能直接无限进入下一轮。
8. **继续原 stage**：若原 exact session 仍可证明连续，使用 continuation；若必须新建 child，则创建新的 stage occurrence，并明确 `repairOf`，不得覆盖原 stage 身份。
9. **汇总**：原 stage 完成则 pipeline 继续；修复超限、验证失败或 continuity 不可证明则返回 `BLOCKED`/`PARTIAL`/`ERROR`，并保留完整诊断链。

## 6. JSONL 协议扩展

当前 EventType 已包含 `continuation`、`recovery`、`checkpoint`、`result` 和 `error`。优先复用这些基础事件，通过结构化 payload 表达 repair workflow；只有 replay 复杂度证明不足时才增加新的 EventType。

建议 payload 事件：

| EventType | actor | 关键 payload |
| --- | --- | --- |
| `checkpoint` | coordinator | `attempt`, `transportStatus`, `failureClass`, `failureFingerprint`, `stageIndex` |
| `error` | coordinator | `status`, `failureClass`, `failureFingerprint`, `errorSummary`, `retryable` |
| `recovery` | parent/coordinator | `reason`, `authorizedBy`, `targetStage`, `recoveryMode`, `repairOf` |
| `continuation` | parent/coordinator | `answer` 或 `continuationReason`, `targetStage`, `sourceEventSeq`, `sourceLineStart`, `sourceLineEnd` |
| `status-changed` | coordinator | `status`, `detailStatus`, `attempt`, `retryCount`, `repairCount`, `approvalRequired` |
| `result` | coordinator/child-output-capture | `status`, `attempt`, `repairCount`, `repairOf`, `summary`, `validation` |

所有 relay envelope 必须携带：

- absolute communication file；
- exact event `messageId`；
- exact `seq`；
- exact physical `lineStart`/`lineEnd`/`lineCount`；
- stage role/occurrence；
- expected agent session triple（如适用）；
- read-only/read-and-append 的明确授权边界。

当前 `buildContinuationEnvelope` 的 `latest` seq/lines 只是兼容性临时行为。实现 repair workflow 前必须改为使用刚刚追加 event 返回的真实 `AppendedEvent` 范围，并加入 read-after-write 回归测试。

## 7. Coordinator 调度变化

当前 coordinator 以 pull-driven tick 处理 inbox。修复 workflow 仍应留在这个 coordinator boundary 内，不新增第二个 daemon 或绕过 coordinator 的 child。

需要增加：

1. stage failure classification 和 failure fingerprint；
2. `tick` 对 retry、repair authorization、answer authorization 的优先级；
3. 同一 pipeline 的 repair lock，防止并发 repair attempt；
4. repair stage 的独立 transaction/stage occurrence；
5. repair result 与原 stage 的关联；
6. coordinator busy 时的 durable queue/ack；
7. parent approval 的 bounded control event；
8. stop 对正在等待、修复和验证阶段的统一取消语义。

优先级建议：

```text
STOP
> explicit approval/answer
> exact recovery authorization
> safe transient retry
> repair plan execution
> new pipeline submissions
```

任何状态不确定、binding/session 不一致或 event log 损坏，都必须暂停修复并返回 `BLOCKED`，不能由 repair agent 自行猜测恢复上下文。

## 8. Pi UI 与可观测性

现有 pipeline UI 已能显示 coordinator、current stage、agent、pane 和 summary。修复 workflow 需要增加：

```text
Herdr pipeline <id> · REPAIRING
Stage: worker · attempt 2 · repair 1
Failure: semantic-task-failure
Repair: diagnosing / awaiting approval / executing / verifying
Next action: pipeline.answer / pipeline.recover / coordinator tick
```

debug JSONL 必须记录但必须脱敏：

- failure classification；
- attempt/retry/repair counters；
- source event and target event identities；
- repair stage/session/pane identity；
- approval and stop decisions；
- transition reason 和 error hash。

不得记录完整 task、完整 child output、token、私钥、Cookie 或完整敏感环境变量。

## 9. 配置建议

建议在 `pipelines.default` 增加显式 repair policy，禁止隐藏默认值：

```json
{
  "pipelines": {
    "default": {
      "maxStages": 8,
      "retry": {
        "maxTransientAttempts": 2,
        "backoffMs": 250
      },
      "repair": {
        "enabled": true,
        "maxAttempts": 2,
        "requireApprovalForChanges": true,
        "timeoutMs": 300000
      }
    }
  }
}
```

配置解析必须：

- 拒绝未知字段；
- 验证所有计数、timeout 和 backoff；
- 对危险操作默认要求批准；
- 不允许 repair policy 降低 exact-session、workspace、cwd 或 agentArgs 校验；
- 将实际生效配置写入 task/repair metadata，便于审计和恢复。

## 10. 实施阶段

### Phase R0：协议和状态冻结

- 确认失败分类、stage detail、attempt/repair identity 和状态映射。
- 决定继续复用现有 EventType，还是增加新的事件类型。
- 修正 continuation envelope 的精确 event 物理范围。
- 定义 repair agent role/profile、cwd、autonomy、approval 和输出 contract。

**门槛**：设计审查通过；没有 runtime 改动。

### Phase R1：纯状态与 replay

- 扩展 `PipelineStageState` 和 pipeline replay。
- 实现 failure fingerprint、retry/repair counter、authorization 判定和幂等规则。
- 增加非法顺序、重复授权、重复 answer、损坏 event 和超限测试。

**门槛**：纯单元测试和 typecheck 通过；不启动真实 agent。

### Phase R2：安全瞬态 retry

- 将明确 transport error 映射为有限 retry。
- 验证 relay 不重复发送，且 retry 不绕过 exact session。
- 验证 timeout、abort、pane busy、prompt stalled、capture delay。

**门槛**：gateway/integration 测试通过；失败时能稳定返回 `PARTIAL`/`ERROR`。

### Phase R3：BLOCKED continuation hardening

- 使用真实 continuation event range。
- 验证 `pipeline.answer` 的 answer consumption、coordinator busy queue 和 exact stage reuse。
- 验证同一 answer/message 不会重复执行。

**门槛**：blocked child 在同一 pane/session 中继续并完成；session mismatch 必须 fail closed。

### Phase R4：repair stage

- 创建独立 repair occurrence 和 linked JSONL log。
- 实现 repair plan contract、approval gate、repair execution 和 verification。
- 禁止 repair stage 调用 `pipeline` 或创建 coordinator。

**门槛**：fake gateway、coordinator integration 和最小真实 smoke 均证明 repair 与原 stage 隔离。

### Phase R5：UI、发布和回滚

- 增加 repair progress UI、debug events、status serialization 和文档。
- 完成 package/typecheck/test/audit/pack gates。
- live smoke 覆盖 transient retry、blocked answer、semantic repair approval、repair failure 和 stop。
- 发布前确认旧 JSONL/Markdown 边界、单一 owner 和 rollback 行为不变。

**门槛**：所有 acceptance tests 通过，未验证能力仍标记为风险。

## 11. 测试矩阵

| 层级 | 必须覆盖 |
| --- | --- |
| Pure state | failure classification、fingerprint、counter、limits、state replay、重复授权、重复 answer |
| Relay | exact seq/physical line range、message id、continuation envelope、read-after-write |
| Gateway | transient errors、abort、timeout、pane busy、prompt stalled、session mismatch |
| Coordinator | FIFO、repair lock、busy queue、answer/recovery precedence、stop、crash/replay |
| Repair | plan schema、approval gate、repairOf、独立 stage occurrence、repair result、验证失败 |
| Safety | 重复副作用保护、cwd/workspace 隔离、agentArgs/autonomy 校验、secret redaction |
| UI | `RETRYING`、`REPAIRING`、`WAITING_FOR_APPROVAL`、attempt counters、terminal summaries |
| Live smoke | same-session blocked continuation、transient retry、approved repair、failed repair、stop |

每个新增公共 class/method 必须有参数、返回值和测试关联注释；关键状态转换、锁、幂等和 exact-session 决策必须有简短代码注释。

## 12. 完成定义

修复工作流只有同时满足以下条件才算完成：

- transport retry、blocked continuation、semantic repair 三条路径有明确边界；
- 自动 retry 有上限、幂等和失败终态；
- repair 使用独立 occurrence/log，并与原 stage 可追溯关联；
- parent approval、stop、unknown identity 和损坏 log 均 fail closed；
- continuation relay 使用真实 JSONL event 物理范围；
- coordinator 不被并发 prompt 或 repair attempt 重入；
- Pi UI 和 `pipeline.status` 能区分执行、重试、修复、等待批准和终止；
- fake、integration、typecheck、package 和 live smoke gates 全部通过；
- 文档、配置示例、debug schema、回滚和 release notes 与 runtime 一致。

在这些条件满足前，系统只能宣称支持“显式 answer/recovery continuation”，不能宣称支持“自动修复工作流”。

## 13. 多外部 Agent 并发启动与监控扩展

本节把“同时开启多个外部 Agent 并发监控”纳入 repair workflow 的后续能力范围。它是提案的一部分，当前 runtime 尚未实现。

### 13.1 当前边界与兼容策略

当前行为必须在并发实现期间保持可解释：

- `ry_herdr_delegate_tool` 当前注册为顺序执行模式；单个 tool invocation 不是 fan-out API。
- 独立 leaf 调用可以各自创建外部 Agent、Pane、communication JSONL 和 exact `agent_session`，因此多个子 Agent 可以在 Herdr 中共存；但当前调用路径会等待单个 leaf 结束，不能由一个请求统一启动和汇总多个 leaf。
- 一个 project/workspace 只有一个持久 coordinator binding。当前 `tick` 在 coordinator execution lock 内执行一个 eligible stage，并在外部 Agent 等待期间持有该锁，因此同一 coordinator 不能并发推进多个 stage 或多个 pipeline。
- 同一 pipeline 的 `stages` 当前表示串行计划；数组中有多个 stage 不代表它们会同时执行。
- parent Pi 的 pipeline monitor 虽然按 pipeline identity 保存 timer，但 footer/status 和 widget 使用共享 key；多个 monitor 会互相覆盖可见内容，不能宣称已经提供多 pipeline 聚合监控。
- 不同 Herdr workspace 可以拥有独立 coordinator 状态并分别运行，但这不等于单个 coordinator 已经支持并发；跨 workspace 的汇总 UI 也不在当前实现中。

并发功能实现并上线后，默认策略为 `enabled: true`、`maxAgents: 3`、`maxPipelines: 1`、`maxConcurrentStages: 3`。并发配置属于配置 schema v2：配置加载器必须先接受 schema v1，补入上述内存默认值并记录 `configMigration: v1-to-v2`，再执行严格未知字段校验；不得让旧 runtime 写入或解释 v2 并发日志。旧的未声明 `stageId`/`dependsOn` 输入仍规范化为串行链，只有显式声明可并发的 stage plan 才会使用多个 slot。并发 runtime 尚未实现前，当前代码仍按串行行为运行。

`maxAgents` 只统计 coordinator worker pool 启动的 stage/repair child，不统计绕过 coordinator 的独立 `delegate` leaf；因此 direct leaf 不得宣称受 workspace 并发 quota 或聚合 monitor 管理，但仍必须通过同一 workspace-scoped layout/resource lock。direct leaf 默认使用 `access: workspace-write` 和 canonical `cwd:<effectiveCwd>` resource key；没有显式 resource declaration 时按该保守策略处理。direct leaf 与 coordinator active stage 争用同一 Pane 布局或 canonical resource 时，direct leaf 必须返回 `BLOCKED`，不能绕过锁继续执行。若未来要把 direct leaf 纳入 quota，必须另行增加 shared workspace reservation boundary，不得隐式复用本节的内存 slot。

### 13.2 目标并发模型

并发采用 coordinator 内的有界 worker-slot 模型，而不是创建第二个 coordinator 或绕过现有 pipeline boundary：

1. 一个 project/workspace 仍只绑定一个长期 coordinator child；coordinator 本身不计入 worker slot。
2. coordinator 从多个 pipeline inbox 和同一 pipeline 的 ready stages 中选择任务，在 workspace 级 `maxAgents` 限制内启动多个独立 stage execution。
3. 每个并发 stage 必须拥有独立的 transaction、stage id/occurrence、attempt、communication file、Pane、agent target 和 exact session；不得共享 child session 或 communication log。
4. 同一 pipeline 是否允许并发必须显式表达。建议扩展 stage schema：使用稳定 `stageId` 和 `dependsOn`；字段省略表示 legacy compatibility，按输入顺序生成 `legacy-stage-<stageIndex>` 并补成串行链，显式 `dependsOn: []` 才表示从 pipeline 起点 ready 并可并发，显式依赖列表表示 DAG 边。新的 `stageId` 必须通过稳定标识符校验且在 pipeline 内唯一；规范化后的 stage id、依赖和并发策略必须写入 task event，不能只在内存中推导。
5. 每个 pipeline 和 workspace 都要有独立上限：`maxConcurrentStages` 控制单 pipeline，`maxAgents` 控制 coordinator worker pool，`maxPipelines` 控制同时活跃的 pipeline 数量；较小的限制优先。v2 coordinator binding 必须持久化 `activePipelineReservations`，每项包含 pipeline id、reserved slots、lease ids、owner epoch 和 release sequence；它是 reservation ledger 的 derived projection，不能继续用单一 `activePipelineId` 推断多任务占用。
6. 调度必须公平：当存在竞争 pipeline 时，同一 pipeline 不能占满所有 slot；inbox 采用 FIFO 加 ready-stage round-robin，跳过已被 lease、等待答案、等待批准或 stop 的 stage，并记录跳过原因。`maxPipelines: 1` 时不伪造跨 pipeline 并发公平性，仍必须保证同一 pipeline 的 ready wave 不被单个 stage 重复 claim。
7. 并发只改变可独立执行任务的调度顺序，不改变 stage 的 exact-session recovery、JSONL provenance、completion contract 或 repair approval 规则。
8. 外层 Pi tool 仍可保持 `executionMode: "sequential"`；并发 fan-out 必须发生在一次 exact coordinator `pipeline.coordinator` 调用内部的 worker pool 中，不得依赖多个交错的 Pi tool invocation。

### 13.3 阶段声明与资源隔离

并发不能只依赖模型自行判断“两个任务是否会冲突”。每个 stage 必须补充可 replay 的资源声明：

| 字段 | 作用 |
| --- | --- |
| `stageId` | pipeline 内稳定的逻辑 stage identity；attempt/occurrence 不得替代它 |
| `dependsOn` | 必须先完成的 stage id 列表；禁止循环、未知引用和自引用 |
| `access` | `read-only`、`workspace-write` 或 `external-side-effect` |
| `resourceKeys` | 需要独占或共享的 cwd、文件树、服务、端口或外部资源标识 |
| `failFast` | 当前 stage 失败是否取消同一 pipeline 的其他 active stages |
| `maxConcurrentStages` | pipeline 对自身 active stage 的上限 |

安全规则：

- `workspace-write`、`external-side-effect` 和所有 repair stage 默认使用独占 resource lease；资源声明缺失或无法验证时按冲突处理并返回 `BLOCKED`。
- 两个 `read-only` stage 可以共享明确相同的只读资源，但不得共享 Pane、communication file 或 exact session。
- 同一 cwd 上的 repair stage 与未知 access stage 不得并行；需要并行时必须通过显式 resource key 或隔离 worktree 证明不会互相覆盖。
- stage 的 `cwd` 必须先按 project root、允许的 worktree 根和 path policy 解析为 `effectiveCwd`；相对路径、符号链接、worktree 和不存在的尾部路径必须有确定的 canonicalization 规则，无法证明归属时返回 `BLOCKED`。
- `resourceKeys` 必须持久化为 canonical key：文件资源使用 realpath 或最近存在祖先的 realpath 加规范化尾部，端口/服务/外部副作用使用带 namespace 的显式 key；共享与独占冲突矩阵必须可 replay。
- stage 的 `cwd`、workspace、agent profile、materialized agentArgs/autonomy、effective timeout 和 canonical resource keys 必须在 task event 中持久化，恢复时按原值验证，不能按当前默认配置重建。

### 13.4 Lease、锁与 JSONL 事件

现有 coordinator execution lock 不能继续覆盖整个外部 Agent 等待，否则并发 slot 只是名义上的并发。实现必须拆分为 claim/commit 锁和可取消的 active-run 监控：

1. 在短暂的 coordinator execution lock 内读取并 replay 状态、检查依赖和资源、分配 attempt、写入 `stage-claimed`/`stage-started` 事件并取得带 fencing token 的 lease。
2. Pane split/start、tab 分配和初始 pane metadata 更新使用 workspace-scoped layout lock；布局变更完成并写入 stage identity 后释放 layout lock。
3. 释放全局 execution lock 后并发执行各 stage 的 `DelegateEngine.run`；每个 stage 使用自己的 `AbortController`、timeout、Pane 和 exact session。coordinator 同时运行 control poller，发现 durable stop/answer/approval/recover event 时按 target stage 触发对应 controller。
4. stage 返回后重新取得 execution lock，验证 attempt、lease 和 fencing token 仍属于当前 coordinator，使用 RecordStore/PipelineStore 单写者顺序追加 checkpoint/result/release 事件；过期、已取消或 fence 不匹配的结果只能作为诊断事件，不能覆盖新 attempt。

每个 lease 至少包含：`pipelineId`、`stageId`、`stageOccurrence`、`attempt`、`fencingToken`、`owner`、coordinator exact session、resourceKeys、`acquiredAt`、`expiresAt`、`lastHeartbeatAt`、`communicationFile`、`paneId`、`agent`、`agentSession` 和 cancellation state。active lease 使用 `leaseTtlMs`，默认必须大于允许的 resolved stage timeout、capture grace 和 control margin，并由 coordinator 按 `heartbeatMs` 续租。`resolvedTimeoutMs` 必须定义为从 stage claim 到最终 result/cancellation 的单一绝对 stage deadline；prompt、wait、startup、terminal capture 和 pane disposition 只能消费剩余预算，不能每次 Herdr 操作重新计时。续租失败或 fencing token 不匹配时，stage 不得自行重试。

lease 不能仅依赖内存 Map；进程崩溃后必须能从 JSONL replay 判定 active、expired、completed 或需要人工恢复。lease 过期后，只有在 exact pane/session 被明确证明已关闭，或 parent 已持久化 stop 并确认旧 attempt 已取消时，才允许创建新 attempt；未知、working 或 metadata 不完整时必须 `BLOCKED`，不得用 lease expiry 推断 child 已结束。

并发事件必须保持单写者和幂等：

- parent/coordinator 仍是 authoritative pipeline JSONL 的唯一写者，child 只返回结果或 terminal capture；所有新增 `stage-claimed`、`stage-started`、`stage-released`、`pipeline.control` 和 `stale-attempt-diagnostic` 事件必须先注册到 v2 typed event schema，未知事件在 replay 时 fail closed；
- stage-scoped event 必须携带 stage/attempt identity 和适用的 `fencingToken`；pipeline/workspace-scoped control event 必须携带 `targetScope`、稳定 `targetStageIds`/target reservation set、control id、pipeline fence 和每个 target 的 expected attempt/fence。两类事件都使用 `(scope, pipelineId, controlOrStageId, occurrence, attempt, eventKind)` 计算幂等键；
- pipeline replay 对 stage event 只有在 attempt/fence 与当前 stage lease 一致时才能更新 authoritative stage status；对 pipeline/workspace control event 则必须验证 targetScope、target reservation set、pipeline fence 和 control idempotency state。迟到或 fence 失效的 result/error/control 只能追加为 `stale-attempt-diagnostic`/`stale-control-diagnostic`，不能覆盖新 attempt 或重新取消已释放 target；
- 维护 workspace-scoped reservation ledger（独立 JSONL 与 sidecar lock），它是 slot claim/release 的唯一 authoritative source；`activePipelineReservations` 和 pipeline progress 中的 reservation 字段都是 replay 后的 projection，不能分别决定 quota。
- claim transaction 在 execution lock 内先追加带 `reservationId`/`reservationEpoch` 的 intent，再追加 commit，并将同一 reservation id 写入 pipeline `stage-claimed`；result commit 后追加 release。任一步骤崩溃都由 reconciliation 根据 ledger、pipeline log 和 fence 恢复为 committed、released 或 orphan-pending；orphan reservation 在确认没有对应 fence-valid stage 后才能释放，未决期间不得再次分配该 slot。
- binding 更新、ledger append 和 pipeline event append 不假设跨文件原子性；通过 reservation id、epoch、writer fence 和可重放 reconciliation 保证不会 double-claim。每次 coordinator tick 先 replay ledger，再重建 binding projection，最后才选择 ready stage。
- 并发结果按实际 append 顺序获得全局 seq，同时保留 `startedAt`、`finishedAt`、lease identity 和 dependency snapshot，replay 不得依赖文件中“刚好按 stage 顺序出现”；
- 每个 stage 的 communication event 仍必须使用真实 `AppendedEvent` 物理范围；并发不得重新引入 `latest` seq/lines 指针。

retry classification 的输入也必须持久化：HerdrGateway/DelegateEngine 需要保留 operation（split/start/prompt/wait/read/disposition）、structured error code、relay/message identity、`accepted: true|false|unknown`、observed transport status、exact session checkpoint 和 capture attempt。只有 `accepted: false` 且没有外部副作用，或同一 exact session 的无副作用 reread/wait，才可进入自动 transient retry；`accepted: unknown` 一律进入 `PARTIAL`/`BLOCKED`，不得自动重发 relay。

### 13.5 并发失败、修复与控制语义

并发 stage 必须隔离失败，但遵守 pipeline 的依赖和 stop 语义：

- 一个 stage 的 `ERROR`、`PARTIAL` 或 `BLOCKED` 默认只阻止其 downstream stages；已经运行的独立 sibling stages 可以继续。
- `failFast: true` 时，首个可传播失败会追加 pipeline control event，取消尚未开始的 downstream/peer stages，并对 active stages 发送 AbortSignal；已完成结果不得被覆盖。
- `STOP` 是 pipeline 级操作，必须先在短暂 execution lock 内追加 durable control event，再由 active-run control poller 对所有 target stage 发送 AbortSignal；每个 cancellation 都要有 durable outcome，不能只停止 coordinator prompt。control event 与同时完成的 stage result 按 append lock 顺序定序：已经 fence-valid 提交的 DONE 可保留，尚未 commit 的 attempt 必须成为 CANCELLED/STALE。
- `pipeline.answer` 只授权目标 BLOCKED stage 的 continuation；不能误唤醒其他 stage，也不能在同一 stage 已有 active attempt 时重复启动。旧的只带 `pipelineId` 的调用在存在多个 BLOCKED stage 时必须返回 `BLOCKED` 要求目标，不得继续选择第一个。
- `recover` 必须带目标 `stageId`、occurrence、communication file、Pane、agent、完整 session triple 和 expected attempt/fence。多个失败 stage 同时存在时不得默认选择一个隐含目标。
- approval 必须通过同一 control boundary 的 `approve`/`reject` command，绑定 pipeline、stage、repair occurrence、plan hash 和当前 coordinator/session identity；拒绝必须产生终态或明确回到 `BLOCKED`，不能被普通 answer 当作批准。
- 所有 answer、approve、reject、recover、stop 都统一落为 versioned `pipeline.control` event；现有 `pipeline.answer`、`pipeline.stop` 和 `recover` 仅作为兼容 wrapper，必须把显式 target 和 expected identity 转换到该事件格式。
- repair stage 使用独立 worker slot 和独立 occurrence；可以与无冲突的 read-only stage 并行，但不得与其 repair target 的 active attempt 或同一独占 resource 并行。所有 repair stage 都计入 coordinator `maxAgents`，BLOCKED/WAITING_FOR_APPROVAL 的 pane 不占用 active execution slot，但其 lease、identity 和资源锁必须持续可见，直到显式 release 或终态。执行 lease 与等待 hold 必须是不同状态：`EXECUTING` lease 可 heartbeat/expiry，`WAITING_FOR_ANSWER`、`WAITING_FOR_APPROVAL` 和 `BLOCKED` 使用不占 execution slot 的 durable hold，不因 execution TTL 自动过期；hold 只能由匹配的 answer/approve/reject/recover/stop control 或明确 release 事件结束。stage detail status 必须增加 `CANCELLED`、`STALE`、`WAITING_FOR_ANSWER`、`WAITING_FOR_APPROVAL`，pipeline 顶层仍映射到现有 status 集合。
- repair 完成后，只有原 stage 的 dependency/resource/session 条件重新验证成功，才可以创建 continuation attempt；无法验证时返回 `BLOCKED`，不得用 fresh child 或 generic latest-session fallback 填补空缺。
- coordinator 崩溃或 lease 过期后，恢复流程必须先 replay 所有并发 stage 的最后 checkpoint，再逐个 exact-verify；不能一次性把所有 active stage 当作可安全重试。

### 13.6 多任务状态与 Pi UI

`PipelineProgress` 和 `pipeline.status` 必须从单一 `currentStage` 扩展为可排序的 active/stage collection，至少提供：

- pipeline status、active pipeline 数量和 workspace slot 使用情况；
- 每个 stage 的 `stageId`、role、status/detailStatus、attempt、repairCount、Pane、agent、exact session 摘要和 lease 状态；
- dependency blocked、resource blocked、approval waiting、retrying 和 cancellation 原因；
- 已完成、失败、修复中和等待中的 stage 汇总；
- 不暴露 communication file、session path、token 或完整 child output 到默认可见文本。

parent Pi UI 必须明确 monitor ownership，不得让多个 monitor 争抢同一个 status/widget 内容。每个 parent Pi session 只拥有自己提交的 pipeline monitor，status/widget key 必须包含 session identity；workspace 级聚合只在同一个 parent session 内对其可见 pipeline 做汇总，不能跨 Pi session 共享可写 UI。Herdr workspace 的 durable JSONL 才是跨 session 的权威状态来源。建议改为一个 session-owned 聚合 monitor：

```text
Herdr pipelines · 2 active · 3/4 agent slots
pipeline A · RUNNING · inspect DONE · test RUNNING · docs QUEUED
pipeline B · REPAIRING · worker attempt 2 · awaiting approval
```

聚合 monitor 必须：

- 从 durable JSONL replay 读取状态，不直接轮询 child output；
- 用稳定的 parent Pi session key 防止重复 timer；同一 session 对相同 workspace 只有一个 owner monitor，旧 monitor 必须在 session replacement/shutdown 时释放；
- 对 stage/pipeline 做确定性排序，避免并发完成顺序导致 UI 抖动；
- 在单个 pipeline 终止时保留最终快照，在所有 monitor 终止时清理 timer；
- 将当前 pipeline 的 `pipeline.status`、repair control、stop control 与 UI 显示的 target identity 对齐；
- debug JSONL 记录 slot、lease、queue delay、start/finish、resource conflict 和 aggregate monitor 错误，并继续遵守现有脱敏规则；monitor error 必须经过路径、session、token 和环境字段脱敏，只显示稳定 error code/hash，不直接展示任意 `error.message`。

### 13.7 配置建议

建议在 `pipelines.default` 增加并发策略。配置顶层 schema 升级为 `version: 2`；schema v1 缺少 concurrency 时由 loader 在内存中补入默认策略并记录迁移事件，不自动覆盖用户配置文件。默认开启并发，最多同时运行 3 个 coordinator worker Agent；启用前必须通过完整测试和 live smoke。旧的未声明依赖 stage 仍按串行链执行：

```json
{
  "version": 2,
  "pipelines": {
    "default": {
      "maxStages": 8,
      "concurrency": {
        "enabled": true,
        "maxAgents": 3,
        "maxPipelines": 1,
        "maxConcurrentStages": 3,
        "leaseTtlMs": 600000,
        "startupGraceMs": 30000,
        "captureGraceMs": 10000,
        "controlMarginMs": 30000,
        "heartbeatMs": 10000,
        "controlPollMs": 1000,
        "failFast": false,
        "unknownResourcePolicy": "block"
      }
    }
  }
}
```

pipeline/binding schema migration 不得在 active v1/v2 writer 仍可运行时原地覆盖文件：先取得 workspace migration lock，确认旧 coordinator/process 已 quiesce 或 exact closed，再把旧 v1 workspace state 移入只读 `.quarantine/v1/<timestamp>-<hash>/`，写入包含 source schema、target schema、migration owner、source binding/session、monotonic `schemaEpoch` 和 reason 的 manifest，最后以新的 v2 state directory 原子发布。v2 binding 和每个 v2 event 都携带 `schemaEpoch` 与 `writerFence = schemaEpoch + coordinatorSession + processLease`；所有 write/append 必须在 sidecar lock 内 compare-and-fence，epoch 不匹配只能诊断并 `BLOCKED`。旧 v1 runtime 永远只指向 quarantine 前的路径，不能写入 v2；若无法证明旧 writer 已停止，迁移必须拒绝，不得留下混合 schema。

stage communication logs 也必须纳入迁移边界：旧的 project-level v1 communication file 不能由 v2 runtime 继续 append。迁移器在 record lock 内验证完整 v1 replay 和 event/message identity，将原始文件移入 quarantine，并在新的 workspace-scoped v2 `communications/` 目录创建 linked log；转换保留原 eventId、messageId、transaction、stage occurrence、exact session 和 `legacyLineStart`/`legacyLineEnd` 元数据，新的物理 line range 由 v2 log 重新计算。pipeline v2 event 必须追加不可变的 `communication-link` 映射（旧绝对路径 hash、v2 path、migration id），后续 continuation 只引用 v2 physical range。任何无法验证、正在运行或 identity 不完整的旧 stage log 都阻止迁移并返回 `BLOCKED`，不能原地续写 v1 文件。

- 先按配置 schema version 执行 v1-to-v2 内存迁移，再拒绝未知并发字段；version v1 缺少 concurrency 时使用默认 `enabled: true`、`maxAgents: 3`、`maxConcurrentStages: 3`，但旧未声明依赖 stage 仍串行；迁移后的有效配置和版本必须写入 task metadata；
- 拒绝未知并发字段，验证正整数上限、lease TTL、startup/capture/control margin、heartbeat、control poll interval 和布尔策略；默认 `leaseTtlMs: 600000` 覆盖默认 300000 ms stage timeout 加 `startupGraceMs: 30000`、`captureGraceMs: 10000` 和 `controlMarginMs: 30000`；每个 stage 若 invocation timeout 更大，则在 submission 时把 `effectiveLeaseTtlMs = max(config.leaseTtlMs, resolvedTimeoutMs + startupGraceMs + captureGraceMs + controlMarginMs)` 持久化，禁止运行中临时缩短 lease；且 `heartbeatMs` 必须小于 effective lease TTL 的一半；
- 强制 `maxConcurrentStages <= maxAgents`、`maxPipelines * maxConcurrentStages` 不得突破 workspace 总上限；`maxAgents` 只统计 coordinator worker pool 的 active stage/repair execution，不为 direct leaf 提供 quota 语义；
- `enabled: false` 时允许没有并发依赖的 legacy serial stage plan 正常运行；显式 `dependsOn: []` 或多 ready-stage plan 必须明确返回 `BLOCKED`/配置错误，不能静默规范化为另一种执行语义；
- 将实际生效的 concurrency policy、slot 上限、resource policy、effective cwd/profile/args 和 schema version 写入 task metadata，供 recovery/replay 使用；
- 不允许并发配置降低 exact-session、cwd、workspace、agentArgs/autonomy、approval 或 stop 校验；
- repair stage 计入同一 coordinator `maxAgents`；BLOCKED/WAITING_FOR_APPROVAL 的 child 不占 active execution slot，但其 durable lease/resource identity 直到 release 或终态前必须可见；
- v2 并发 JSONL 和 v2 coordinator binding 不允许旧 runtime 写入。降级时旧 runtime 必须将 v2 状态 quarantine 并返回 `BLOCKED`，不得按 v1 schema 解析或追加。

### 13.8 并发实施阶段

并发扩展必须在现有 repair workflow 阶段之后或作为独立 RC 阶段执行，不能与 repair state migration 混合提交：

#### RC0：并发协议冻结

- 确认 `stageId`/`dependsOn` 的省略、显式空数组和显式依赖三态语义；确认 legacy stage id 生成、task event 规范化和 positional replay 兼容规则。
- 确认 `pipeline.control` 的 versioned payload、target stage/occurrence/attempt/session/fence 字段，以及 answer/approve/reject/recover/stop wrapper 的兼容行为。
- 确认 pipeline event schema v2、coordinator binding v2、`activePipelineIds`/active lease 表达、v1 read-only replay、原子升级和 downgrade quarantine 规则。
- 确认默认并发策略、workspace/pipeline/agent 三层 quota、direct leaf 排除范围、failFast 和旧输入兼容语义。
- 确认 `leaseTtlMs`、`heartbeatMs`、fencing token、lease expiry 和 exact closed-agent recovery 语义。

**门槛**：设计审查通过；无 runtime 改动。

#### RC1：状态、schema 与 replay

- 扩展 `PipelineStageInput`、`PipelineStageState`、`PipelineProgress` 和 pipeline event parser。
- 实现依赖 DAG 校验、ready-wave 计算、legacy stage normalization、lease/attempt/fence replay、resource conflict 判定和幂等 claim。
- 定义并实现 pipeline event schema v2、coordinator binding v2 和 workspace-scoped communication log v2；v1 log/binding/stage communication file 只读兼容，迁移必须在 migration lock 下原子 quarantine/link，降级必须 quarantine，不能双写两套 schema。
- 实现 reservation ledger 的 intent/commit/release/reconciliation，以及 `activePipelineReservations` projection；覆盖跨 binding、ledger、pipeline log 崩溃点，不能 double-claim 或泄漏 slot。
- 定义 stale result/error 的诊断事件和 authoritative replay 规则，确保迟到 attempt 不能覆盖新 attempt；
- 删除或改写仍生成 `MESSAGE SEQ: latest`/`MESSAGE LINES: latest` 的遗留 continuation envelope helper，RC1 完成前不得保留可被恢复路径重新调用的旧协议。
- 覆盖交错 append、重复 claim、过期 lease、heartbeat 丢失、崩溃恢复、循环依赖、旧串行 JSONL 兼容、v1-to-v2 migration、stage communication log link 和 reservation reconciliation。

**门槛**：纯状态测试、replay 测试和 typecheck 通过；仍只允许一个 active stage。

#### RC2：并发执行与资源锁

- 将 execution lock 缩短到 claim/commit 边界，外部 Agent 等待不得持有全局 lock；active-run control poller 必须能够在同一个 coordinator tick 内发现 durable control 并取消目标 stage。
- 增加 workspace worker pool、pipeline quota、resource lease、heartbeat/fencing 和可取消的 per-stage AbortController。
- 增加 workspace-scoped layout lock/Pane allocator 和 shared resource lock；将 coordinator 与 direct leaf 的 Pane split/start/tab move/disposition 串行化，外部 Agent 的正式 relay/wait 并发执行；direct leaf 不占 coordinator quota，但在布局或 canonical resource 冲突时必须 fail closed。
- 验证每个 child 都有独立 exact session、communication log、attempt/fence 和 pane disposition；验证 direct leaf 不被错误计入 coordinator quota。

**门槛**：注入 gateway/integration 测试证明 N 个 stage 最多启动 N 个 child，且不会重复、副作用交叉、越过 quota 或在 lease expiry 后重复 relay。

#### RC3：失败、repair 与控制

- 验证 sibling failure isolation、fail-fast、pipeline.stop、目标化 `pipeline.control` answer/approve/reject/recover、control poller、lease expiry 和 coordinator crash recovery。
- 验证 stop 与同时完成 result 的 fencing/排序，以及旧 wrapper 在多 BLOCKED/FAILED stage 下不会隐式选择错误 target。
- 验证 repair stage 的 slot/resource/approval 规则，以及 repair target 不会与自身 active attempt 并行。
- 验证单个 stage 的 retry/repair 不会阻塞无关 stage，也不会覆盖其他 stage 的 result/status；`accepted: unknown` 不会自动重发 relay。

**门槛**：fake gateway 和 coordinator integration 覆盖成功、失败、BLOCKED、PARTIAL、ERROR、STOPPED、approval、session mismatch、stale attempt 和 control race。

#### RC4：多任务 UI、live smoke 与发布

- 将单 pipeline monitor 改为 parent-session-owned 聚合 monitor，并为 active/queued/repairing/blocked/terminal stages 提供稳定排序；不同 Pi session 不共享可写 status/widget key。
- live smoke 至少同时启动两个无冲突 Agent，验证独立 Pane、session、JSONL、result、lease、stop 和 UI；再验证一个 pipeline 三个 stage 的 quota 与公平性。
- 覆盖一个 sibling 失败、一个 sibling 成功、一个 repair 等待批准和一个 pipeline stop 的混合场景；覆盖 direct leaf 不纳入 coordinator quota 的边界。
- 完成 package、typecheck、test、audit、pack、release、安装和重启验证；旧的未声明依赖 stage 必须保持串行，显式 `enabled: false` 配置下的 legacy serial plan 必须可运行而显式并行计划必须 fail closed，v2 状态降级必须 fail closed。

**门槛**：所有 acceptance tests 和 live smoke 通过，UI 能看到多个 active stage，且未验证的并发范围明确标记为风险。

### 13.9 并发验收标准

多 Agent 并发能力只有同时满足以下条件才可对外宣称完成：

- 一个明确的请求或 pipeline plan 可以在有界 quota 内创建多个独立 child Agent，并为每个 child 持久化独立 Pane、communication log 和 exact session；
- coordinator 可以同时等待多个 stage，而不持有阻塞其他控制和 claim 的全局 execution lock；
- stage claim、lease、heartbeat、fencing token、attempt、resource lock 和 result append 具备跨进程幂等、崩溃恢复和 replay 语义；lease expiry 不能导致仍运行的 child 被重复 relay；
- versioned `pipeline.control` 能精确定位 stage/occurrence/attempt/session/fence，answer、approval、recover、stop 的 race 和 legacy wrapper 都有明确结果；
- v1 配置、旧串行 JSONL、旧 stage communication log 和 v1 coordinator binding 可只读迁移或明确 quarantine，v2 runtime 不双写，旧 runtime 不会误读 v2 状态；
- reservation ledger、binding projection 和 pipeline event log 在 crash/replay 后能一致恢复 claim/release，不会泄漏或重复分配 slot；
- `maxAgents: 3` 的 scope 明确为 coordinator worker pool，repair 计入 quota，direct leaf 明确排除且不在 UI 中伪装为 workspace aggregate；
- 同一 pipeline 的依赖、资源冲突、repair target、approval、answer、recover 和 stop 都按 stage identity 定位，不会串台；
- 一个 stage 失败不会默认杀死无关 sibling，`failFast` 和取消传播有明确且可测试的策略；
- `pipeline.status` 与 Pi UI 能同时展示多个 active/queued/repairing stage，且不会暴露内部路径、session 或 raw details；
- 不同 Herdr workspace 的状态、锁、Pane 和 debug session 不互相污染；
- 默认并发策略（`enabled: true`、`maxAgents: 3`）下，旧的未声明依赖 stage 仍按串行链运行；显式禁用并发、旧 JSONL replay、exact-session recovery、repair workflow 和现有发布回滚仍然通过；
- fake gateway、integration、live smoke、typecheck、package、audit 和 diff checks 全部通过。

在这些条件满足前，系统只能宣称“已实现有界并发 vertical slice，repair workflow 和完整多 Agent 调度仍在硬化”，不能宣称“支持可靠的多 Agent 并发调度与自动修复”。
