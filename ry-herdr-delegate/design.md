# ry-herdr-delegate 自有实现设计

> 状态：设计已落地为当前 TypeScript runtime contract；实现已覆盖 leaf delegation、JSONL event log、HerdrCliGateway、pipeline coordinator、基础控制动作和 pipeline recovery；live smoke 仍待完成。
>
> 本文记录 `ry-herdr-delegate` 从旧 prompt-level Skill 演进为 TypeScript Pi Extension 的目标与边界。当前 active owner 是项目自有的 `ry_herdr_delegate_tool`；旧 Markdown/外部 `herdr_delegate` 路径仅保留为整体回滚背景，不参与新 runtime 的状态或恢复。

## 1. 目标与边界

目标是实现一个由本项目自己维护的 `ry_herdr_delegate_tool`，不再运行时调用以下两个包的工具：

- `@andrewjacop/pi-herdr`
- `@ogulcancelik/pi-herdr`

可以参考这两个包公开代码中的 CLI 参数、pane 生命周期和状态处理方式，但运行时代码应通过本项目自己的适配层调用 `herdr` CLI。`ry-herdr-fork` 和 `ry-herdr-clone` 目前已经直接使用 standalone `herdr` CLI，可以继续保持现状。

本次演进负责代码化以下内容：

- 配置解析、角色和 profile 解析；
- `agentArgs` 构造、校验和 exact-session resume 参数；
- Herdr pane、tab 和 agent 的生命周期操作；
- JSONL communication event log 的创建、追加、恢复和状态维护；
- wait 后的 checkpoint、child 输出读取和语义结果判定；
- `close`、`keep`、`new-tab` 三种 pane disposition；
- 单阶段 delegation、pipeline coordinator、队列和 recovery。

runtime 进程边界固定为本项目的 `HerdrCliGateway`：它使用 `node:child_process.spawn`、argv 数组、`shell: false`、显式合并的 `cwd`/`env`、AbortSignal/timeout 和 stdout/stderr 捕获。`pi.exec` 只继续用于现有 `ry-herdr-fork`/`ry-herdr-clone` 启动器，不是新 delegate gateway 的执行边界。

一般自然语言意图识别和复杂任务拆解仍可由当前 Pi 模型完成；但 extension 会在模型回合前识别有限且明确的 agent 工作指令（例如“使用 Codex 修复”或“使用 Claude 审查”），直接转换为 `ry_herdr_delegate_tool` 的 `delegate` action，并将原提示词作为 task。闲聊、否定句、slash command、非 TUI 输入和 Pi 忙碌时不会自动拦截。其余复杂意图仍必须由模型转换为结构化的 `ry_herdr_delegate_tool` 调用。不能把关键副作用继续留给 prompt 约束。

`pipeline` 是特殊的后台提交入口，不由主 Pi 执行 stage loop。主 Pi 只创建或复用当前 Herdr workspace 中的长期 `pipeline-coordinator` 子 agent，写入 pipeline 请求并返回 `pipelineId`；coordinator 子 agent 在自己的 Pi session 和 pane 中负责规划、调度、等待、恢复和汇总。主 Pi 可以继续处理新的用户消息。

## 2. 当前实现与目标实现

| 当前实现 | 目标实现 |
| --- | --- |
| 项目自有 TypeScript extension，注册 `ry_herdr_delegate_tool` | 继续以结构化 tool 作为唯一 active owner |
| `HerdrCliGateway` 通过 `spawn` 调用 standalone `herdr` CLI | 保持 `shell: false`、显式 cwd/env、timeout/cancellation 和 JSON capability errors |
| JSONL event log 是 runtime communication/state authority | 继续补齐通用 record recovery 和 live smoke |
| leaf engine 与 pipeline coordinator 已覆盖基础串行路径，并发 vertical slice 已开始实现 | 完成剩余 coordinator/recovery hardening、并发控制/replay 和发布验证 |
| 旧 `SKILL.md` 未注册为 active skill，仅作 rollback material | 整体回滚到旧 package，而不是在新 runtime 中读取旧 Markdown |
| `SKILL.md` 描述流程，模型自行调用多个 Herdr 工具 | 一个 `ry_herdr_delegate_tool` 直接执行完整 delegation 流程 |
| 运行时依赖 `@andrewjacop/pi-herdr` 的 `herdr_delegate` | 本项目自己的 `HerdrCliGateway` 调用 `herdr` CLI |
| 模型负责参数展开、记录、等待和恢复 | TypeScript 负责确定性状态和副作用 |
| `agentArgs` 依赖 prompt 中的强制要求 | 代码在最终 CLI 调用前构造并校验 argv |
| 旧 prompt-level 实现使用 Markdown communication record | 新版本只使用 JSONL event log；不读取、导入或转换旧 `.md` 文件 |
| 多个工具调用由模型编排 | 主 Pi 只提交请求；长期 coordinator 子 agent 持有队列并编排 stage |
| 主 Pi 等待 pipeline 的所有 stage 完成 | 主 Pi 快速获得 accepted/queued 回执，stage 等待由 coordinator 完成 |

目标实现不应把两个 `pi-herdr` 包加入 `package.json` 的 runtime dependencies。若需要复用代码，应优先重新实现 CLI 适配逻辑；若直接复制 MIT 代码片段，必须保留版权和许可证声明。

## 3. 公共 Pi Tool

Extension 注册一个高层工具：

```text
ry_herdr_delegate_tool
```

工具输入采用结构化参数，不重新解析整段自然语言：

```json
{
  "action": "delegate",
  "task": "实现 xxx，并运行测试",
  "role": "worker",
  "agent": "codex",
  "effort": "high",
  "extraArgs": [],
  "cwd": "/absolute/project/path",
  "timeoutMs": 300000,
  "panePolicy": "new-tab"
}
```

建议支持以下 action：

| Action | 调用方和用途 |
| --- | --- |
| `delegate` | 执行一个独立的 leaf stage；可由主 Pi直接使用，也可由 coordinator 调用 |
| `pipeline` | 向当前项目的长期 coordinator 提交 pipeline 请求；不在当前主 Pi turn 中执行 stage |
| `pipeline.status` | 查询 coordinator、队列和指定 pipeline 的持久状态 |
| `pipeline.answer` | 给处于 `BLOCKED` 的 coordinator 或 stage 写入人工回答并唤醒它 |
| `pipeline.stop` | 停止当前 pipeline；不默认销毁长期 coordinator |
| `pipeline.coordinator` | 打开、检查、精确恢复或停止 coordinator 的管理入口 |
| `recover` | 从已有 JSONL event log 恢复；pipeline event log 只能路由给已有或 exact-resumed coordinator |

`pipeline` 请求示例：

```json
{
  "action": "pipeline",
  "task": "实现并审查这个功能",
  "cwd": "/absolute/project/path",
  "timeoutMs": 300000,
  "panePolicy": "new-tab"
}
```

调用返回的是提交回执，而不是最终 stage 结果：

```json
{
  "status": "QUEUED",
  "pipelineId": "pipeline-20260812-7f3a",
  "communicationFile": "/absolute/project/path/.pi/agent/ry-herdr-delegate/communications/pipeline-20260812-7f3a.jsonl",
  "coordinator": {
    "paneId": "w12:p6",
    "agentSession": { "kind": "id", "source": "herdr", "value": "..." }
  }
}
```

JSONL event log 是通信与状态的机器权威格式，采用 JSONL（NDJSON）append-only event log。每个物理行是一个完整 JSON event；任务正文中的换行由 JSON 编码为 `\n`，不得产生跨行 JSON。Codex、Claude 和其他 child 不需要专用插件，不负责写入或解释完整 pipeline 状态；它们只读取 relay 指定的 event 并返回 completion contract。若普通文件读取不稳定，可以提供一个 parent-owned 的共享只读 `ry-herdr-record read` 命令复用同一解析器，但该命令不是 child plugin，也不是状态 owner。

pipeline 的 stage 计划可以由请求提供，也可以留给 coordinator 生成。即使请求带有 `stages`，主 Pi 也只负责传递约束；最终顺序、并发、worker/reviewer 隔离和失败处理由 coordinator 校验并执行。

对于 `delegate`，输入中的 `agent`、`effort` 和 `extraArgs` 是 invocation-local overrides：它们沿用现有 prompt-level profile override 的优先级，只对本次调用生效，经过同一套配置和 `agentArgs` preflight 校验，绝不写回全局配置。

coordinator 子 agent 使用同一个 `ry_herdr_delegate_tool` 调用 leaf `delegate` action，但禁止递归调用 `pipeline` 或创建第二个 coordinator。这样公共工具仍只有一个，pipeline 的长期生命周期由 coordinator session 承担。

内部入口保持单一：

```ts
interface DelegateEngine {
  run(request: DelegateRequest, context: DelegateContext): Promise<DelegateResult>;
}
```

工具层只负责校验输入、获取 Pi context 和格式化结果；所有 Herdr 副作用由 `DelegateEngine` 及其依赖执行。

## 4. 内部模块

建议的目录结构：

```text
ry-herdr-delegate/
  index.ts                 # Pi Extension 入口
  tool.ts                  # 注册 ry_herdr_delegate_tool
  types.ts                 # 请求、结果、状态和 session identity
  config.ts                # 配置解析、profile 和 role resolution
  args.ts                  # agentArgs 与 exact resume args
  engine.ts                # leaf delegation orchestration
  pipeline.ts              # coordinator 侧 stage 规划和隔离
  pipeline-coordinator.ts  # coordinator session 的提交、唤醒和生命周期
  coordinator-store.ts     # project/workspace 绑定、队列和持久状态
  coordinator-prompt.ts    # coordinator bootstrap 和 relay envelope
  records.ts               # JSONL event log、追加、重放和锁
  record-reader.ts         # 共享只读解析/校验；可承载可选 record read 命令
  recovery.ts              # open-pane reuse 和 exact-session resume
  result.ts                # child 输出与语义结果解析
  pane-policy.ts           # stage 的 close、keep、new-tab
  herdr/
    client.ts              # herdr CLI process adapter
    agent.ts               # agent start、prompt、wait、get、read
    layout.ts              # pane split、tab create、pane move、close
    snapshot.ts            # agent_session 和 pane metadata
    version.ts              # CLI capability detection
    fixtures/              # Phase 0 capability probe fixtures
```

`HerdrCliGateway` 是唯一允许执行 `herdr` 子进程的模块。其他模块只能依赖接口：

```ts
interface HerdrGateway {
  splitPane(input: SplitPaneInput): Promise<Pane>;
  startAgent(input: StartAgentInput): Promise<Agent>;
  prompt(agent: AgentTarget, text: string): Promise<void>;
  waitFor(
    agent: AgentTarget,
    statuses: PaneStatus[],
    timeoutMs: number,
  ): Promise<PaneStatus>;
  getAgent(agent: AgentTarget): Promise<AgentSnapshot>;
  readAgent(agent: AgentTarget): Promise<AgentOutput>;
  createTab(input: CreateTabInput): Promise<Tab>;
  movePane(input: MovePaneInput): Promise<void>;
  closePane(pane: PaneTarget): Promise<void>;
  snapshot(): Promise<HerdrSnapshot>;
}
```

`splitPane` 必须支持显式的 `sourcePaneId`。主 Pi 首次创建 coordinator 时以当前 pane 为 source；coordinator 创建 worker/reviewer stage 时以 coordinator pane 为 source。coordinator pane 自己永远使用 `keep` 策略，不得被 stage 的 `new-tab` disposition 移走或关闭。

测试使用 `FakeHerdrGateway`，不需要启动真实 Herdr server。

## 5. Herdr CLI 适配

生产适配器直接执行 `herdr` CLI。实现必须使用 Node `spawn`，不要把该 gateway 改写成 `pi.exec`：

```ts
spawn("herdr", argv, {
  cwd,
  env: { ...process.env, ...profileEnv, ...ownerEnv },
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  signal,
});
```

`timeoutMs` 通过 AbortController 或等价的 process-kill 机制实现；gateway 必须等待子进程退出并捕获 stdout/stderr，再转换为统一的 `Result` 或明确异常。`pi.exec` 的 `ExecOptions` 不提供 `env`/`shell` 字段，因此只保留给既有 fork/clone 扩展。

禁止把 argv 拼接成 shell 字符串，也禁止通过 `shell: true` 传递任务内容或 agent 参数。

目标调用流程如下：

1. `herdr pane split --current ...` 创建 child pane；
2. `herdr agent start <name> --kind <kind> --pane <pane> -- <agentArgs...>` 启动 child；
3. 等待 child 达到可接受的初始状态；
4. `herdr agent prompt <target> <relay-envelope>` 发送 relay prompt；
5. `herdr agent wait <target> ...` 等待状态变化；
6. `herdr agent get <target>` 获取 pane、agent 和 `agent_session`；
7. `herdr agent read <target>` 捕获 child 输出；
8. 必要时调用 `herdr api snapshot` 补全 session 或 workspace metadata；
9. 成功完成后调用 pane disposition 所需的 tab/pane 命令。

CLI 命令、JSON 输出和状态值应集中在 `herdr/` 目录内。上面的命令清单是目标 gateway contract，不是对当前仓库已有调用的事实保证；实现必须先针对 Herdr 0.8+ 运行 capability probe，验证每个命令、参数和 JSON shape，再允许对应能力进入 engine。目标 Pi 版本为 0.83+，必须同时验证 `ExtensionAPI.registerTool()`、TypeBox schema 和 tool execute contract。若 Herdr 版本或 Pi 版本不支持某一能力，gateway 返回结构化 capability error，而不是让上层猜测或静默降级。

## 6. Agent 参数与配置

配置解析顺序保持为：

```text
role override -> selected profile -> global defaults -> built-in defaults
```

当前 profile 的默认自主执行参数可以保留：

| Agent | 默认参数 | 说明 |
| --- | --- | --- |
| Codex | `--yolo` | leaf stage 的默认 Codex profile |
| Claude | `--dangerously-skip-permissions` | leaf stage 的默认 Claude profile |
| Pi | 无自主执行参数 | leaf stage 的默认 Pi profile |
| Coordinator | `kind: pi`，使用独立 coordinator profile | 不是第四种 Herdr agent kind，也不是普通用户 stage role |

coordinator profile 必须显式定义 `model`、`effort`、`extraArgs`、`env` 和 approval/autonomy policy，不能静默继承 leaf Pi profile。`env` 只有在 Phase 0 已验证 Herdr child-env 通道时才允许为非空；否则配置解析必须返回 capability error。Pi 没有本项目可以假定的内置自主执行 flag；因此 v1 只有在 capability probe 确认了可用的非交互策略后才允许 unattended coordinator 启动，否则返回 `BLOCKED` 并保留已写入的 pipeline JSONL event log。

代码应在每一次 `agent start` 或 exact-session continuation 前生成最终参数：

初次启动的 Pi `normalArgs` 不得包含 `--session`。Pi 的 exact resume 只在关闭 pane 后追加一次 `--session <saved-path>`；Codex 和 Claude 分别追加 `resume <id>` 与 `--resume <id>`。

```text
normalArgs = modelArgs + effortArgs + profileExtraArgs + roleExtraArgs
resumeArgs = exact-session-specific arguments
finalArgs = normalArgs + resumeArgs
```

`finalArgs` 必须满足：

- 是实际传入 gateway 的非空字符串数组；
- 不包含未展开的 `{model}`、`{effort}` 等占位符；
- 不包含 null、非字符串项或隐式 shell 片段；
- exact resume 时只追加与记录中 session identity 对应的参数；
- 不把通用 `recoveryArgs` 当作 exact-session 参数；
- 在调用 `herdr agent start` 前再次校验。

如果最终 argv 无法确认，必须在打开 pane 前返回 `BLOCKED` 或 `ERROR`。

## 7. Delegation 与 Coordinator 生命周期

### 7.1 主 Pi 的提交路径

主 Pi 调用 `ry_herdr_delegate_tool({ action: "pipeline" })` 时只执行短生命周期的提交操作：

1. 解析项目根目录、当前 Herdr workspace、请求约束和 pipeline/stage pane policy；
2. 在 `projectRoot + workspaceId` 的 coordinator binding 锁内查找长期 `pipeline-coordinator`；
3. 如果 coordinator 不存在，使用当前 pane 作为 source 创建一个 sibling pane，并启动一个独立的 Pi child session；只有 exact session、pane 和 workspace metadata 验证成功后才发布 binding；
4. 如果 coordinator pane 明确关闭，使用 binding 中的 exact `agent_session` 精确恢复；
5. 如果 pane/session metadata 暂时未知，保留旧 binding 并返回 `BLOCKED` 或 `PARTIAL`，不能创建 fresh coordinator 覆盖原绑定；
6. 在同一持久化事务中创建 pipeline JSONL event log 并写入完整请求，再写入一个只包含 `pipelineId`、enqueue sequence、event log 路径/范围和当前状态的轻量 inbox entry。完整请求只有 event log 是 authoritative source；
7. 检查 coordinator 的 exact session 和 transport state：
   - `working` 或 `blocked`：不得发送新的 prompt；依靠 coordinator 在当前 stage 安全边界读取 inbox，立即返回 `QUEUED`；
   - `idle` 或刚完成启动且已验证可接收 prompt：发送 relay envelope；`done` 只有在 get/snapshot 确认 pane 仍打开且 exact session 可复用时才按 `idle` 处理；
   - `unknown`：不发送 prompt，保留已持久化的 queue entry，返回 `PARTIAL` 或 `BLOCKED`；
8. 只对已发送 prompt 的情况等待一个短的、明确有上限的 coordinator ACK，不等待任何 worker/reviewer stage；
9. coordinator 必须通过 `COORDINATOR -> PARENT` 的 `accepted` event 和 `queueState: accepted` 回执。主 Pi 在短超时内重新读取并验证该 event 后才返回 `ACCEPTED`；没有回执但 queue entry 已持久化时返回 `QUEUED`；
10. 返回 `QUEUED`、`ACCEPTED` 或明确的 `BLOCKED`/`PARTIAL`/`ERROR`。任何状态都不能把 stage 的最终结果伪装成提交回执。

`QUEUED` 表示请求已可靠写入 JSONL event log 和 inbox，但 coordinator 尚未确认接收；`ACCEPTED` 表示 coordinator 已在同一 event log 中确认接收。两者都不表示任何 stage 已完成。

因此主 Pi 不持有 pipeline stage loop，不读取每个 stage 的输出，也不负责 pipeline 的最终等待。主 Pi 在收到提交回执后可以继续处理新的用户消息。

### 7.2 长期 Coordinator 子 Agent

coordinator 是当前 Herdr workspace 中的长期 sibling pane 和独立 Pi session。它不是一次请求创建的一次性 worker，而是项目级的调度进程：

```text
主 Pi 当前 pane
  └─ pipeline-coordinator pane / Pi child session  (长期保留)
       ├─ worker stage pane / Codex session
       ├─ reviewer stage pane / Claude session
       └─ 其他 stage pane
```

coordinator session 启动时读取固定 bootstrap contract，必须遵守：

- 保持自己的 pane 打开并在 stage 完成后回到 idle；
- 读取 inbox/JSONL event log，而不是依赖主 Pi 的上下文记忆；
- 负责 pipeline 规划、队列、并发上限、stage 顺序、失败和人工阻塞；
- 每个 stage 使用新的 transaction/stage event log 和 exact child session；
- 只能调用 `ry_herdr_delegate_tool` 的 leaf `delegate` 路径，不得调用 `pipeline`、创建第二个 coordinator 或把调度权交回主 Pi；
- coordinator 的调用边界由 runtime exact-session guard 强制执行：启动时记录 coordinator 的 project/workspace/session identity，并在 `DelegateContext` 中绑定该三元组。可选的 `RY_HERDR_EXECUTION_OWNER=coordinator` 环境变量只作为额外诊断信号，不能作为唯一安全边界；tool 在 binding/session 表示 coordinator 时拒绝 `pipeline`、`pipeline.coordinator` 的创建操作和递归启动，返回结构化错误；
- 在每个 stage wait 后写 checkpoint、读取输出、验证语义结果；
- 将 coordinator 结果写回 pipeline JSONL event log，并在完成后保持 session/pane 可复用。

coordinator 的长期性来自 Herdr pane、Pi session、binding 和持久 inbox，而不是要求模型无限循环。它处理完一个请求后保持 idle；下一次 `pipeline` 提交复用同一 exact session。若 coordinator 正在处理任务，新请求只追加到持久 inbox，由 coordinator 在当前 stage 安全边界读取和确认；主 Pi 不通过并发 prompt 打断 coordinator。

bootstrap 中的“不递归”文字只是协作合同，不是安全边界。runtime exact-session guard、binding session 校验和 tool action guard 才是强制规则；owner marker 缺失时不能降低 guard 强度；缺少或互相矛盾的 binding/session metadata 必须返回 `BLOCKED`，不能按普通主 Pi 请求处理。

### 7.3 Coordinator 内部调度

coordinator 可以从高层 task 规划 stage，也可以校验请求提供的显式 stage。调度器应保证：

- 同一 pipeline 的默认 stage 顺序为串行；明确标记为独立的阶段才允许有限并发，并受 workspace reservation、lease/fence、layout/resource lock 和 quota 约束；完整 repair workflow 仍以专项计划为准。
- worker、reviewer、scout 等每个 stage 都创建独立 child session 和 linked JSONL event log；
- reviewer 不会因为 worker 使用了相同 agent kind 就复用 worker session；
- stage 结果、checkpoint、阻塞和重试状态写入 JSONL event log；
- stage 结束后按 stage 的 `panePolicy` 处理 pane，但 coordinator pane 永远保留；
- 一个 pipeline 失败或 BLOCKED 时，不影响 coordinator 接收其他项目请求；
- coordinator 重启后从队列和最新有效 JSONL event log 状态恢复，而不是从模型上下文猜测进度。

coordinator 的执行相当于 `pi-subagents` 的长期子 agent 形态：它有独立上下文和工具调用能力，但与当前 `pi-subagents` 的 parent-owned `workflowScript` 不同，pipeline 的执行权明确属于这个长期子 session。

### 对 `pi-subagents` 的借鉴与差异

本设计借鉴本地已安装 `pi-subagents` 的以下边界：

- child 是独立 Pi session，而不是主 session 中的隐式函数调用；
- 后台任务需要稳定的 run identity、状态、恢复信息和可观察性；
- child 应有明确的角色合同、递归限制和与 owner 的通信通道；
- pipeline/coordinator 的状态不能只依赖当前对话上下文。

但本项目不直接调用 `pi-subagents` 的 `subagent` tool，也不把它的 `workflowScript` 当作 pipeline owner。`pi-subagents` 当前的 chain/workflow 仍由 parent session 创建并拥有调度；本设计新增一个长期 Herdr coordinator pane，使 pipeline 的队列和 stage loop 真正属于 coordinator session。主 Pi 只通过持久 inbox、binding 和状态查询与 coordinator 通信。

### 7.4 单个 Leaf Stage

coordinator 调用 leaf `delegate` 时执行以下流程：

1. 解析 stage role、profile、cwd、timeout 和 pane policy；
2. 创建 transaction/stage scope 和 linked JSONL event log；
3. 将完整 stage handoff 写入 JSONL event log；
4. 构造并校验 `agentArgs`；
5. 以 coordinator pane 为 source 创建 stage pane 并启动 child；
6. 发送只含 JSONL event log 路径和精确范围的 relay envelope；
7. 由 coordinator 等待 child 状态变化；
8. 每次 wait 返回后执行 checkpoint、session lookup 和输出捕获；
9. 解析 child completion contract；
10. 只有语义结果为 `DONE` 时才执行 stage pane disposition；
11. 将结果返回给 coordinator scheduler，并写入 pipeline JSONL event log。

初次启动必须保持 stage pane，不在启动调用中执行 disposition：

```text
panePolicy = pending
```

只有 coordinator 在 completion contract 验证为 `DONE` 后，才将有效 policy 解析为 `close`、`keep` 或 `new-tab` 并执行。关闭或移动动作不能由 child 或主 Pi 初始提交路径执行。

## 8. 状态模型

必须区分 transport state 和 semantic result：

| 类型 | 值 | 含义 |
| --- | --- | --- |
| Transport state | `working`、`blocked`、`idle`、`done`、`unknown` | Herdr pane 当前生命周期 |
| Semantic result | `DONE`、`BLOCKED`、`PARTIAL`、`ERROR` | 任务是否达到完成条件 |

Herdr 返回 `idle` 或 `done` 不等于任务完成。判定 `DONE` 至少需要：

- child 输出包含合法 completion contract；
- JSONL event log 已保存 child result；
- parent 已保存本次 wait 的 checkpoint；
- exact `agent_session` 已确认；
- 没有未解决的阻断、超时或写入错误。

以下情况必须保留 pane，并返回未完成状态：

- timeout；
- child 被权限确认或用户问题阻塞；
- session metadata 缺失或不一致；
- child 输出格式错误；
- JSONL event log 追加失败；
- pane disposition 失败。

## 9. Communication Event Log

记录目录保持为：

```text
./.pi/agent/ry-herdr-delegate/communications/
```

路径相对于当前项目根目录解析，传给 child 时使用绝对路径。新 runtime 的机器权威格式是 JSONL（NDJSON）append-only event log：每个 exact child session、transaction 和 stage scope 使用一个 JSONL event log。pipeline 另有一个 coordinator event log 作为请求、队列、pipeline 状态和最终汇总的 authoritative source；每个 stage event log 通过 `previousCommunication` 和 pipeline id 链接到它。主 Pi 只负责创建并写入初始请求，coordinator 负责后续调度、checkpoint、stage 结果和最终汇总。

不提供 Markdown communication record 的兼容、导入或转换。新版本遇到旧 `.md` record 时必须返回明确的 `ERROR`/`BLOCKED`，不得读取其内容、猜测状态或创建隐式转换副本。只有新 runtime 创建的 `.jsonl` event log 才能进入 `recover`、`pipeline.status` 和状态重放流程。

```text
npm-worker-7f3a.jsonl
```

`.jsonl` 去掉后的 basename 是稳定的 `communicationId`，后续 new-tab 名称使用它。`communicationFile` 字段继续表示通信文件，但新值必须是 `.jsonl` 的绝对路径。

### 9.1 Event schema 与状态重放

每个物理行必须是一个完整、紧凑、以换行结束的 JSON object；任务正文中的换行编码为 JSON 字符串中的 `\\n`，不能产生跨行 JSON。事件至少包含：

- `schemaVersion`：事件 schema 版本；
- `seq`：event log 内单调递增的 1-based 序号；在没有空行和截断尾行时，`seq` 必须等于物理行号；
- `eventId`：事件唯一 id；
- `timestamp`：UTC 时间；
- `type`：事件类型；
- `actor`：`parent`、`coordinator`、`system` 或 `child-output-capture`；
- `transaction`、`stageRole` 和 `stageOccurrence`；
- 可选的 `messageId`、`previousCommunication`、`previousSession`、session/pane/workspace/tab metadata；
- `payload`：经过敏感值清理的结构化内容。

最小事件示例：

```json
{"schemaVersion":1,"seq":12,"eventId":"evt-...","messageId":"msg-...","timestamp":"2026-08-12T12:00:00.000Z","type":"task","actor":"parent","transaction":"tx-...","stageRole":"worker","stageOccurrence":1,"payload":{"task":"实现 xxx\\n并运行测试","role":"worker","agent":"codex"}}
```

事件类型至少包括：

- `event-log-created`；
- `task`；
- `continuation`；
- `recovery`；
- `checkpoint`；
- `accepted`；
- `status-changed`；
- `result`；
- `error`；
- `pane-disposition`。

不再使用可变 frontmatter。`status`、`lastStatus`、`lastMessageId`、`recoveryCount`、session identity 和 pane metadata 都由 `RecordStore` 按 event log 的 `seq` 顺序重放事件得到；如需快速查询，可以写入独立的 pipeline projection，但 projection 不是通信事实来源。事件追加后不得修改历史行。

状态重放必须拒绝以下情况：重复或跳跃的 `seq`、重复 `eventId` 但 payload 不同、重复 `messageId` 但内容不同、非法 JSON、未知的必需 schema 字段和敏感值未清理。最后一行不完整或非法时不能静默忽略；必须返回 `BLOCKED`/`ERROR`，由显式 repair 流程备份原 event log 并生成 linked event log 后再继续。

### 9.2 Append、锁和幂等

coordinator event log 的消息方向包括 `PARENT -> COORDINATOR`、`COORDINATOR -> PARENT` 和 `CHECKPOINT`；direction 作为事件 payload 或 metadata 保存。stage event log 保存 parent handoff、child result、checkpoint、recovery 和 pane disposition。所有跨进程追加都必须通过 `proper-lockfile` 提供的 filesystem sidecar lock（event log 使用同目录的 `<communicationId>.jsonl.lock`，binding 使用 `pipeline-coordinator.json.lock`）串行化。

一次追加必须在锁内完成：

1. 读取并验证整个 JSONL，确认没有非法尾行；
2. 按最后一个有效 `seq` 计算下一个序号；
3. 检查 `eventId`/`messageId` 是否已经存在；相同完整事件视为幂等重试，不得重复追加；同一 id 对应不同内容则失败；
4. 追加一行紧凑 JSON，并确保以单个换行结束；
5. 重新读取并验证 `seq`、`eventId`、`messageId`、物理行号和行数；
6. 释放锁。

不能让主 Pi、coordinator 和 stage child 无锁地同时修改同一 event log。父进程内的 `RecordStore` 只是这个跨进程锁协议和 event replay 的调用封装，不是只存在于某一个进程内存中的互斥量。child v1 不直接写 event log；coordinator/parent 捕获 child 输出后以 `child-output-capture` 或 `result` 事件作为唯一 result writer。

### 9.3 Child 读取与 relay envelope

Codex、Claude 和其他 child 不实现各自的通信插件，不负责完整 event log 的写入、状态重放或恢复。child 只读取 relay 指定的事件，执行任务，并返回既定 completion contract。普通文件读取是 v1 的默认方式；如果实际 smoke 证明解析不稳定，可以提供 parent-owned 的共享只读 `ry-herdr-record read` 命令，复用 `record-reader.ts`，负责路径归属、JSON schema、`seq`、`messageId` 和行范围校验。该命令不是 Codex/Claude 专用插件，也不是状态 owner。

每次发送任务前必须：

1. 完整写入 parent handoff event；
2. 重新读取并校验实际 event 的 `messageId`、`seq` 和物理行范围；
3. 记录 message id、序号、起止行和行数；
4. 仅把 relay envelope 发送给 child。

relay envelope 只包含：

```text
COMMUNICATION FILE: /absolute/path/to/record.jsonl
MESSAGE SEQ: 12
MESSAGE LINES: 12-12
MESSAGE LINE COUNT: 1
MESSAGE ID: <message-id>
MESSAGE TYPE: task

Read and parse this JSONL event before acting.
Return the required completion contract.
Do not delegate recursively.
```

任务正文、角色合同、pipeline 上下文、约束和完成合同都必须先写入 event log，不能复制进 relay prompt。child 不能因为使用 Codex 或 Claude 就获得额外的 event-log 写入权限或协议分支。

## 10. Session isolation 与恢复

JSONL event log 的身份由完整 `agent_session` 三元组确定：

```text
(kind, source, value)
```

只有以下条件全部相同，才能复用 pane、session 和 JSONL event log：

- 同一个 transaction；
- 同一个具体 objective；
- 同一个 stage role 和 occurrence；
- 同一个 exact `agent_session`。

pane id、agent name、cwd 或 agent kind 单独相同都不足以复用。新的 transaction、pipeline stage、role、objective 或 effective profile 必须创建新的 child session 和 linked JSONL event log。尤其是 `worker -> reviewer` 即使都解析到 Codex，也必须隔离。

### Coordinator Binding 与持久队列

coordinator 绑定不放在 JSONL event log 中，而放在项目/workspace 分区的持久文件：

```text
./.pi/agent/ry-herdr-delegate/workspaces/<workspace-hash>/pipeline-coordinator.json
```

绑定至少包含：

- `schemaVersion`；
- `projectRoot`、Herdr `workspaceId` 和 source `tabId`；
- coordinator `paneId`、agent name、cwd；
- 完整 `agent_session` 三元组；
- `agent_session.value` 必须是可恢复的稳定值：coordinator 使用 Pi 时，它是稳定存储上的完整 session JSONL 路径；该文件在 binding 生命周期内必须存在且可读；
- `status`、`lastSeenAt`、`inboxPath` 和当前 active pipeline id；
- coordinator 创建时间和最近一次恢复信息。

同一个 `projectRoot + workspaceId` 默认只允许一个 active coordinator。binding 的首次创建和替换必须在一个独占的 sidecar lock 下完成：先原子创建或 CAS 写入临时文件并 rename，再重新读取 binding；如果竞争者已经发布 binding，当前调用必须采用已存在的有效 binding，而不是再启动 pane。pane id 改变但 exact session 未变时更新 binding 并继续复用；exact session 改变时必须创建 linked coordinator event log，不能覆盖原 event log。

pipeline inbox 和状态应持久化在同一 workspace 分区下：

```text
./.pi/agent/ry-herdr-delegate/workspaces/<workspace-hash>/pipelines/
```

每个 pipeline 有稳定 id、请求 JSONL event log、状态、队列位置、当前 stage、结果 event log 和错误信息。inbox entry 只保存 `pipelineId`、单调 enqueue sequence、event log 路径/消息范围和 queue state；完整请求、stage 计划和结果只以 JSONL event log 为 authoritative source。coordinator 可以在 Pi session 重启、Herdr 重启或主 Pi 重启后从这些文件恢复。

### Recovery 路由

`action: recover` 读取并重放完整 JSONL event log 后，若 event log 属于 leaf stage，交给对应 stage owner；若 event log 属于 pipeline，则先查找绑定的长期 coordinator。主 Pi 不直接接管 pipeline stage：

1. coordinator pane 打开且 exact `agent_session` 一致时，复用原 coordinator；
2. coordinator pane 明确关闭时，用原 exact session 恢复同一个 coordinator；
3. pane/session 状态暂时未知时返回 `BLOCKED` 或 `PARTIAL`；
4. 只有用户明确要求放弃旧 coordinator，或旧 session 已明确不可恢复，才允许创建新的 linked coordinator；
5. coordinator 恢复后从 pipeline JSONL event log 的最新有效状态继续，不重跑已验证的 `DONE` stage。

主 Pi 的提交、状态查询、人工回答和恢复请求都必须通过 coordinator binding 路由。

exact-session 参数：

| Agent | Exact resume |
| --- | --- |
| Pi | `--session <path>` |
| Codex | `resume <session-id>` |
| Claude | `--resume <session-id>` |

`--last`、`--continue` 和 fresh agent 只能作为普通恢复提示，不能证明 exact continuity，也不能替代 exact-session resume。

## 11. Pane disposition

配置使用三态 `panePolicy`：

| Policy | 行为 |
| --- | --- |
| `close` | stage 语义 `DONE` 后关闭 stage pane |
| `keep` | 保留 stage pane，不做移动或关闭 |
| `new-tab` | 创建关闭态 tab，并把 stage pane 移入其中 |

stage 默认值为 `new-tab`。coordinator pane 是长期基础设施，固定使用 `keep`，不接受 pipeline 请求中的 `close` 或 `new-tab`。只有 stage completion contract 验证为 `DONE` 后，coordinator 才能执行 stage disposition。

`new-tab` 的名称严格为：

```text
closed-pane-<communicationId>
```

其中 `communicationId` 是 communication JSONL 文件 basename，不使用随机 token，也不使用 agent session id。创建 tab 时不自动聚焦，且必须在原 pane 所属 workspace 中创建；然后将 pane 移入该 tab。source tab、target tab 和移动结果都写入 `pane-disposition` event。

未完成结果和 disposition 失败都应尽量保留 pane，并返回 `BLOCKED`、`PARTIAL` 或 `ERROR`。

## 12. 自然语言入口

推荐的第一版权威入口是结构化 tool，而不是 Extension 自己通过关键词扫描所有用户输入：

| 行为 | 处理方式 |
| --- | --- |
| 结构化 delegation | 由 `ry_herdr_delegate_tool` 执行 |
| `/ry-herdr-agent` | Extension command 转换为 tool request |
| `旧 /skill:ry-herdr-delegate` | 仅作为旧版本回滚材料；新 runtime 不读取其通信文件，也不将其请求转成 JSONL |
| `用 Claude 写代码` | 当前 Pi 模型识别后调用 tool，并设置 invocation-local agent |
| 任意自然语言意图分类 | 不在 Extension 内硬编码关键词 |
| pipeline 规划 | coordinator 子 agent 生成或校验结构化 `stages`，主 Pi 只传递请求约束 |
| session sticky state | coordinator binding、inbox 和 JSONL event logs 持久化；主 Pi 不持有调度上下文 |

自动触发必须尊重显式不委托、当前 session 执行和 JSONL event log recovery 等更高优先级规则。比较、历史描述、引用和否定句不能仅因为出现 `Codex` 或 `Claude` 就触发 delegation。

## 13. Package 迁移

实现时预计调整：

| 文件 | 变化 |
| --- | --- |
| `package.json` | 从 `pi.skills` 移除 active `ry-herdr-delegate`，并将 `ry-herdr-delegate/index.ts` 加入 `pi.extensions`；同步更新 `files`、test script 和 runtime dependency |
| `ry-herdr-delegate/herdr/fixtures/` | 保存 Phase 0 capability probe fixtures |
| `ry-herdr-delegate/tsconfig.json` 或仓库级 `tsconfig.json` | 新增 runtime extension 的类型检查配置 |
| `ry-herdr-delegate/pipeline-coordinator.ts` | coordinator session 的 bootstrap、队列唤醒、提交回执和恢复 |
| `ry-herdr-delegate/coordinator-store.ts` | project/workspace binding、inbox、pipeline 状态和锁 |
| `ry-herdr-delegate/coordinator-prompt.ts` | 长期 coordinator 的固定角色合同和 relay envelope |
| `ry-herdr-delegate/records.ts` | JSONL event log、append/replay、幂等校验和 sidecar lock |
| `ry-herdr-delegate/record-reader.ts` | 只读 event/message 校验；必要时供 `ry-herdr-record read` 共享命令使用 |
| `ry-herdr-delegate/SKILL.md` | 旧版本回滚材料；新 runtime 不把它作为 communication 或 delegation owner |
| `README.md` | 更新安装、使用、配置和架构说明 |
| `package.json` | 不添加两个 `pi-herdr` 包作为 runtime dependency；`proper-lockfile` 作为 runtime dependency 并按 Pi package 规则加入 bundledDependencies |

是否保留旧 Skill 文件，只是 package 回滚材料的发布选择，不是新 runtime 的通信兼容层。新版本不读取旧 Skill 产生的 Markdown 文件，不把旧请求转换为 JSONL，也不允许旧 `herdr_delegate` 工具与新 tool 并行执行同一请求。启用新 runtime 时，旧 `@andrewjacop/pi-herdr` delegate tool 必须卸载或禁用，并通过 `/reload` 或重启 Pi 使配置生效。真正的 Herdr 副作用都必须进入 TypeScript engine。

## 14. 测试与验收

至少需要以下测试层：

| 层级 | 覆盖内容 |
| --- | --- |
| Pure unit | 配置解析、role resolution、argv、resume args、JSONL schema/replay、seq/messageId/物理行号、幂等、非法尾行、结果解析 |
| Fake gateway | split、coordinator start/reuse、queue submit、prompt stalled、busy、wait timeout、blocked、session mismatch |
| Coordinator integration | 多次 submit、FIFO/并发限制、coordinator 保活、stage 链接、主 Pi 非阻塞回执 |
| Event-log integration | JSONL append/replay、schema 校验、尾行损坏、read-after-write、幂等重试、`proper-lockfile` 跨进程锁、并发 writer、event-log identity 和 linked event log |
| JSONL reader | 共享只读路径归属、消息范围和敏感值校验；不提供 Codex/Claude 专用插件或 child 写入能力 |
| Package/typecheck | `registerTool` 注册、extension discovery、`npm run typecheck`、npm pack、active Skill 移除 |
| Live smoke | Herdr 0.8+ coordinator pane、Codex/Claude stage、new-tab、exact resume |

验收条件：

- 主 Pi 提交 pipeline 后不等待 worker/reviewer stage，不持有 pipeline loop；
- pipeline request 的 `panePolicy` 只作为 stage pane 默认值，coordinator pane 永远使用 `keep`；
- `QUEUED` 只表示 JSONL event log/inbox 持久化成功，`ACCEPTED` 还必须有 bounded coordinator ACK；
- coordinator 创建、替换和恢复受 project/workspace binding 的 OS-level lock/CAS 保护，不会因并发提交产生两个 active coordinator；
- 主 Pi 不会在 coordinator `working`/`blocked` 时发送并发 prompt；
- 当前 Herdr workspace 中存在可复用的长期 coordinator child pane；
- 多次 pipeline submit 进入持久队列，并由同一个 exact coordinator session 调度；
- coordinator pane 不会因 stage 完成而被关闭或移动；
- coordinator 恢复不会使用 fresh session 冒充 exact continuity；
- coordinator 的递归 pipeline/second-coordinator 行为由 runtime exact-session guard、binding session 校验和 tool guard 拒绝；owner marker 只能作为额外诊断信号，不能作为唯一安全边界；
- 所有 event-log writer 使用 `proper-lockfile` sidecar lock，或由 coordinator 作为唯一 child-output/result writer；
- Codex、Claude 和其他 child 不需要专用通信插件，不能成为 event-log 状态 owner；
- 源码不 import `@andrewjacop/pi-herdr` 或 `@ogulcancelik/pi-herdr`；
- 新版本不读取、导入或转换旧 Markdown communication file；遇到旧 `.md` 路径必须返回明确错误；
- 源码不调用 `herdr_delegate` 工具；
- 所有 Herdr CLI 调用都经过唯一的 `HerdrCliGateway`；
- 每次 agent 启动都有实际非空且校验过的 argv；
- 不使用 shell 字符串拼接；
- 未完成任务不会自动关闭或移动 stage pane；
- new-tab 名称严格为 `closed-pane-<communicationId>`；
- worker 和 reviewer 不复用 child session；
- capability probe 在 engine 使用目标 CLI 命令前验证命令、参数和 JSON shape；
- JSONL event log replay、损坏尾行、幂等重试和只读 JSONL reader 均有测试；
- `git diff --check`、`npm run typecheck`、单元测试和 live smoke 通过；

## 15. 实施顺序

1. Phase 0 先验证 Herdr CLI、Pi `registerTool`、spawn/env 边界、child-env 通道和 coordinator autonomy；
2. 定义 `types.ts`、`HerdrGateway` 和 coordinator binding 接口，并为 gateway 建立 fake；
3. 实现配置解析与 `agentArgs` builder，包括固定的 coordinator profile、exact-session guard 和可选 owner marker；
4. 实现 JSONL event schema、append/replay、seq/messageId/物理行号校验、敏感值清理、幂等和 `proper-lockfile` sidecar lock；
5. 实现 coordinator pane 的创建、binding CAS、exact-session reuse/resume、bootstrap 和持久 inbox；
6. 实现 `pipeline submit/status/answer/stop`，定义 `QUEUED`/`ACCEPTED` ACK 协议，并确保主 Pi 只等待 bounded submit ACK；
7. 实现 coordinator 内的 leaf stage engine、wait/checkpoint/result 状态机；
8. 实现 stage pane disposition 和 pipeline 状态汇总；
9. 实现 pipeline recovery、队列恢复和 linked JSONL event logs；
10. 注册 Pi tool 和 command，移除 active 旧 Skill 入口，不实现旧 Markdown record 兼容；
11. 更新 README、package manifest、配置示例和 typecheck/test wiring；
12. 运行 fake gateway、coordinator integration、binding race、cross-process event-log lock、event-log integration、typecheck 和 live smoke 测试。

设计原则只有一句话：**主 Pi 只提交和查询，长期 pipeline-coordinator 子 agent 负责规划与调度，TypeScript engine 负责确定性状态和副作用，Herdr CLI 负责可见进程传输，JSONL event log 负责持久通信、状态重放与恢复，OS-level lock/CAS 负责跨进程一致性，exact session 和 transaction/stage 负责隔离；Codex/Claude child 不需要专用通信插件，transport state 永远不能替代 semantic completion。**
