# ry-herdr-delegate 实施计划

> 状态：Phase 0-4 的主要 runtime 路径、pipeline recovery、并发 vertical slice 和共享 AgentTurnMonitor 已在 dirty worktree 落地；仍需完成 live smoke、发布硬化和最终 release gate。
>
> 修复工作流专项计划见 [repair-workflow-plan.md](./repair-workflow-plan.md)；外部 Agent 监听重构方案已进入本地 runtime 实现，live smoke 和发布验证仍待完成。
>
## 1. 当前基线

| 范围 | 当前状态 | 本计划处理方式 |
| --- | --- | --- |
| `ry-herdr-delegate` | 当前 active owner 是项目自有 TypeScript tool/engine；旧 `SKILL.md` 仅作 rollback material | 保持 pipeline recovery、live smoke 和发布硬化；不读取旧 Markdown communication |
| `ry-herdr-fork` / `ry-herdr-clone` | 已直接调用 standalone `herdr` CLI，有共享启动器和测试 | 不改行为，只参考 `CommandExecutor`、错误处理和 fake 测试模式 |
| package manifest | 已注册 delegate extension，并从 `pi.skills` 移除 active delegate Skill | 保持单一 delegation owner，并验证安装后 tool discovery |
| Herdr | 目标运行时为 Herdr 0.8+ | 先做 capability probe，未验证的命令和 JSON shape 不得进入 engine |
| Agent monitor | `agent-monitor.ts` 已统一 leaf/pipeline 的 relay 后观察、exact identity、baseline、terminal capture、bounded PARTIAL 和 Pi fallback | 继续补 gateway/monitor 回归、live smoke 与 release gate |
| 设计文档 | `design.md` 已定义 coordinator、JSONL event log、exact session 和 pane policy | 作为实现 contract；本文件只负责落地顺序 |

## 2. 目标与非目标

### 目标

1. 提供一个由 TypeScript 实现的 `ry_herdr_delegate_tool`，直接负责 leaf delegation、pipeline submit/status/answer/stop、coordinator 管理和 recovery。
2. 通过唯一的 `HerdrCliGateway` 使用 `herdr` CLI；runtime 不调用 `@andrewjacop/pi-herdr` 或 `@ogulcancelik/pi-herdr` 的工具。
3. 将 `agentArgs`、JSONL event log、wait checkpoint、语义结果和 pane disposition 从 prompt 约束迁移到代码。
4. 让 pipeline 由长期 coordinator pane/session 持有，主 Pi 只提交、查询和回答人工阻塞。
5. 保留 exact `agent_session`、transaction/stage isolation、`QUEUED`/`ACCEPTED` 和 `close`/`keep`/`new-tab` 语义。

### 非目标

- 不重写 `ry-herdr-fork` 或 `ry-herdr-clone`。
- 不把两个 `pi-herdr` 包加入 runtime dependency。
- 状态查询和持久 JSONL event log 是唯一正确性来源。
- 不在 Extension 中硬编码完整自然语言意图分类；只识别明确的 Codex/Claude 工作指令并直接转为结构化 `delegate` request，其他意图仍以结构化 tool request 为权威入口。
- 不使用 `--last`、`--continue`、fresh agent 或随机 session 代替 exact-session recovery。
- 不在第一阶段实现完整 repair workflow；当前并发 vertical slice 只覆盖有界 ready-wave 调度，repair/control migration 仍按专项计划推进。

## 3. 第一条可运行 Vertical Slice

第一条可运行路径必须是一个单 stage `delegate`，在真实 Herdr 0.8+ 中完成以下闭环：

1. Pi tool 收到结构化 `delegate` 请求。
2. 配置解析出 profile、cwd、timeout、pane policy 和 autonomy 参数。
3. TypeScript 创建 JSONL event log 并写入完整 parent handoff event。
4. `agentArgs` builder 生成并校验实际非空 argv；normal start 不包含 resume 参数。
5. `HerdrCliGateway` 通过 `node:child_process.spawn`（`shell: false`、显式 `cwd`/合并后的 `env`、可取消 timeout、捕获 stdout/stderr）创建 sibling pane、启动 agent、发送 relay envelope、等待并读取输出。新的 delegate gateway 不使用 `pi.exec`；fork/clone 的既有 `pi.exec` 启动器保持不变。
6. 每次 wait 后保存 session checkpoint；缺失或不一致时返回 `BLOCKED`/`PARTIAL`。
7. coordinator/parent 作为 v1 的唯一 event-log writer 追加 child result，解析 completion contract，并区分 `DONE`、`BLOCKED`、`PARTIAL`、`ERROR`。
8. 只有语义 `DONE` 才执行 stage pane policy；`new-tab` 生成 `closed-pane-<communicationId>`。
9. 返回结构化结果和 exact recovery metadata。

在这条 vertical slice 通过 fake gateway、integration test 和一次 live smoke 前，不开始 pipeline coordinator 的复杂调度实现。

## 4. 分阶段实施

### Phase 0：冻结外部 Contract

**范围**

- 对 Herdr 0.8+ 验证 `pane split`、`agent start`、`agent prompt`、`agent wait`、`agent get`、`agent read`、`tab create`、`pane move`、`pane close` 和 `api snapshot`。
- 记录成功响应、错误响应、状态值、agent session 字段和 pane/workspace/tab 字段的 fixture；fixture 固定放在 `ry-herdr-delegate/herdr/fixtures/`，只供测试和 capability probe 回归使用，不作为运行时事实来源。
- 确认新的 `HerdrCliGateway` 使用 `node:child_process.spawn`，通过 argv 数组传参，固定 `shell: false`，显式合并环境变量，支持 `cwd`、AbortSignal/timeout 以及 stdout/stderr 捕获；`pi.exec` 只继续服务现有 fork/clone 路径。
- 验证目标 Pi 版本的 `ExtensionAPI.registerTool()`、TypeBox 参数 schema 和 tool execute contract；当前 package 的最低目标仍为 Pi 0.83，API 不兼容时必须先记录替代入口决策。
- 单独验证 `herdr agent start` 是否把调用方的 profile `env` 传递到实际 child agent。若没有可验证的 child-env 通道，v1 必须拒绝非空 profile `env` 并返回 capability error，不能静默丢弃；coordinator 的强制递归 guard 必须改用 exact coordinator session identity，不得只依赖环境变量。
- 验证 Pi coordinator 是否有可用的非交互 approval/autonomy 策略；不能从 leaf Pi profile 静默推断。

**产出与门槛**

- capability probe contract、fixture 文件和 `herdr/version.ts` 的验证规则。
- 每个命令的参数、JSON shape、错误码和不支持时的结构化 capability error。
- `registerTool`、spawn/env 边界、Herdr child-env 传递和 coordinator 非交互策略的验证结果。
- 如果核心 Herdr 命令或 `registerTool` 无法验证，停止实现并更新设计决策；如果只有 child-env 无法验证，则保留 exact-session guard 路径并阻止依赖 env 的配置进入 v1。

### Phase 1：纯 TypeScript 基础层

**拟新增模块**

- `ry-herdr-delegate/types.ts`
- `ry-herdr-delegate/config.ts`
- `ry-herdr-delegate/args.ts`
- `ry-herdr-delegate/records.ts`
- `ry-herdr-delegate/records.ts`（包含 parent/coordinator-only 的 JSONL event/message 读取、校验和 replay；不新增独立 child reader）
- `ry-herdr-delegate/result.ts`
- `ry-herdr-delegate/recovery.ts`（JSONL replay、session recovery 的纯逻辑）
- `ry-herdr-delegate/pane-policy.ts`（disposition 决策的纯逻辑）
- `ry-herdr-delegate/tsconfig.json` 或仓库级 `tsconfig.json`
- 对应的 `*.test.ts`

**实现内容**

- 定义 request/result/status/session identity、role/profile、pipeline 和 pane policy 类型。
- 实现配置优先级：invocation-local override、role/profile、global default、built-in default；非法字段必须 fail closed。
- 实现 normal args、coordinator args、Codex/Claude/Pi exact resume args；校验非空字符串数组、占位符、重复 resume 参数和 autonomy 参数。
- 实现 JSONL event schema、append/replay、`seq`/`eventId`/`messageId`/物理行号校验、敏感值清理、幂等重试和 event-log identity。任务正文必须保持单行 JSON 编码；非法 JSON、跳号、冲突 id 和不完整尾行都必须 fail closed。
- 使用 `proper-lockfile` 的 filesystem sidecar lock：event log 使用 `<communicationId>.jsonl.lock`，coordinator binding 使用 `pipeline-coordinator.json.lock`；锁的 stale/retry 策略、释放和异常恢复必须有跨进程测试。
- v1 选择 parent/coordinator 作为唯一 result writer；child 输出由 gateway 捕获后写入 `child-output-capture`/`result` event，避免多个进程无序修改同一文件。
- `records.ts` 只提供 parent/coordinator 使用的路径归属、schema、消息范围、敏感值校验和 replay；Codex/Claude 不获得专用插件或 event-log 写权限。若 live smoke 证明普通文件读取足够，不注册 `ry-herdr-record read` 命令，也不新增 `record-reader.ts`。
- 增加 `tsconfig.json`、`npm run typecheck` 和必要的 `typescript`/`@types/node` devDependencies；类型检查必须覆盖新增 extension 源码和现有共享模块。

**完成条件**

- 纯单元测试覆盖配置、argv、exact resume、JSONL schema/replay、`seq`/messageId/物理行号、幂等重试、非法尾行、锁失败、结果解析和 redaction。
- `npm run typecheck` 通过，且不依赖真实 Herdr 或外部 `pi-herdr` 包。
- 所有公共类型、类和方法有参数/返回值注释；复杂状态转换有短注释，并使用 `TEST:<file>[<case>]` 关联测试。

### Phase 2：Herdr Gateway 与 Leaf Delegate

**拟新增或调整模块**

- `ry-herdr-delegate/herdr/client.ts`
- `ry-herdr-delegate/herdr/agent.ts`
- `ry-herdr-delegate/herdr/layout.ts`
- `ry-herdr-delegate/herdr/snapshot.ts`
- `ry-herdr-delegate/herdr/version.ts`
- `ry-herdr-delegate/engine.ts`
- `ry-herdr-delegate/tool.ts`
- `ry-herdr-delegate/index.ts`
- `FakeHerdrGateway` 及其测试

**实现内容**

- `HerdrCliGateway` 是唯一可以启动 `herdr` 子进程的边界；所有 argv 通过数组传递，禁止 shell 字符串拼接。
- capability probe 在 engine 使用目标命令前执行；不支持的命令返回结构化错误。
- 打通第一条 vertical slice：JSONL event log → args → pane/agent → relay → wait/checkpoint → read → result → pane disposition。
- 每次真实 `herdr_delegate` 语义调用都改为本项目 tool 的内部 action，不保留外部同名工具依赖。
- 初始启动统一保持 pane，不在 start 参数中提前关闭；pane policy 只在语义 `DONE` 后执行。
- 处理 prompt stalled、busy pane、timeout、blocked、session mismatch、输出格式错误和 disposition 失败。

**完成条件**

- Fake gateway 测试覆盖成功路径和每种未完成状态。
- 真实 Herdr smoke 完成一次 Codex leaf stage，必要时再完成 Claude stage。
- live smoke 验证实际 agent argv、JSONL event log、checkpoint、exact session 和 new-tab 命名。
- 新版本不发布旧 `SKILL.md` 作为 active 兼容文档；若保留该文件，仅用于旧版本整体回滚，runtime 不读取它或其通信文件。

### Phase 3：Coordinator Binding、Inbox 与提交回执

**拟新增模块**

- `ry-herdr-delegate/coordinator-store.ts`
- `ry-herdr-delegate/pipeline-coordinator.ts`
- `ry-herdr-delegate/pipeline-coordinator.ts`（包含 coordinator prompt builder 和调度逻辑）
- `ry-herdr-delegate/pipeline.ts`

**实现内容**

- 使用 `projectRoot + workspaceId` 作为 coordinator binding key。
- 使用独占 sidecar lock、临时文件和 atomic rename/CAS 创建或替换 binding；并发创建只能发布一个有效 coordinator。
- coordinator pane 创建在当前 pane 的明确 source pane 上完成，成功验证 pane、workspace、tab 和 exact session 后才发布 binding。
- coordinator pane 固定使用 `keep`，并使用独立 coordinator profile、exact coordinator session guard、可选 owner marker 和非递归 action guard。
- pipeline JSONL event log 保存完整请求；inbox entry 只保存 pipeline id、enqueue sequence、event log 路径/范围和 queue state。
- coordinator `working`/`blocked` 时只入队，不发送并发 prompt；`idle` 且 exact session 可复用时才发送 relay。
- 定义 bounded ACK：无回执返回 `QUEUED`，验证到 coordinator `accepted` event 和 `queueState: accepted` 才返回 `ACCEPTED`；两者都不表示 stage 完成。

**完成条件**

- binding race test 证明不会产生两个 active coordinator。
- coordinator busy、unknown、closed、exact resume 和 stale binding 场景有 fake/integration 覆盖。
- 多次 submit 可进入持久 inbox；主 Pi 不等待任何 worker/reviewer stage。
- `QUEUED`、`ACCEPTED`、`BLOCKED`、`PARTIAL`、`ERROR` 的返回条件和 JSONL event-log 状态一致。

### Phase 4：Coordinator Stage 调度与恢复

**拟新增模块**

- `ry-herdr-delegate/pipeline.ts` 的调度状态机
- `ry-herdr-delegate/recovery.ts` 的 coordinator/pipeline recovery
- `ry-herdr-delegate/pane-policy.ts` 的 stage disposition 集成

- coordinator 从显式 `stages` 或高层 task 生成 stage 计划；legacy stage 保持串行，显式 ready wave 在配置和 quota 允许时可并发。
- 每个 worker、reviewer、scout stage 创建独立 transaction/stage scope、child session 和 linked JSONL event log。
- worker/reviewer 即使使用同一 agent kind 也不得复用 session。
- coordinator 负责 stage wait、checkpoint、result、人工阻塞、重试、恢复和 pipeline 汇总。
- `pipeline.status` 只读取 coordinator 状态和持久 JSONL event log，不轮询 stage pane。
- `pipeline.answer` 写入人工决定并按 coordinator transport state 决定是否唤醒。
- `pipeline.stop` 停止指定 pipeline，但默认不销毁长期 coordinator。
- recovery 先验证 pane 是否明确打开、exact session 是否一致；状态未知返回 `BLOCKED`/`PARTIAL`，禁止 silent fallback。

**完成条件**

- coordinator restart、Pi restart、Herdr restart 后可从 binding、inbox 和 JSONL event log 恢复。
- 已验证 `DONE` 的 stage 不重复执行。
- pipeline stage pane policy 生效，coordinator pane 始终保留。
- FIFO、legacy 默认串行、有限 ready-wave 并发边界、人工阻塞和失败隔离均有测试。

### Phase 5：Package 硬切换与旧版本回滚材料

**范围**

- 将 `ry-herdr-delegate/index.ts` 加入 `package.json` 的 `pi.extensions`，并在同一个版本中从 `pi.skills` 移除 active `ry-herdr-delegate`；新版本不发布该 Skill 作为 active 入口。
- live smoke 通过前可以使用显式 `--extension` 做隔离测试，但不允许旧 Skill、旧 `herdr_delegate` 和新 tool 并行成为同一请求的 owner。
- 不新增 Markdown record migration 或 legacy importer；旧 `.md` communication file 不读取、不转换、不恢复。旧 `SKILL.md` 若继续随仓库发布，只作为旧版本整体回滚材料，不作为新版本 active Skill。
- 更新 `README.md`、配置示例、安装说明和设计状态，明确新版本只接受 JSONL event log，Codex/Claude 不需要专用通信插件，旧 Markdown record 不受支持。
- 更新 `package.json.files`，包含所有 delegate runtime `.ts` 源码和 `herdr/` 子目录；更新 `npm test` 或测试发现配置，使新增 delegate 测试实际运行。
- 将 `proper-lockfile` 作为 runtime dependency，并按 Pi package 发布要求加入 `bundledDependencies`；不添加两个 `pi-herdr` 包作为 runtime dependency。

**完成条件**

- 新版本 package 的 active 配置只有一个 delegation owner，且该 owner 是 TypeScript tool；旧 Skill 不作为新版本回滚入口注册。
- `npm pack --dry-run` 的文件清单包含必要 extension、JSONL runtime modules 和配置文件；不要求发布旧 Skill 作为新版本 active 入口。
- package manifest、README、配置示例、旧 Skill 回滚材料和 `design.md` 的 runtime 边界一致。

### Phase 6：发布前硬化

live smoke 的前置条件必须显式满足：Pi 0.83+、Herdr 0.8+ server 正在运行、`pi`/`herdr` 在 `PATH`、目标 Codex/Claude/Pi profile 已完成认证、当前运行在独立 Herdr workspace/pane，并且旧 delegate tool 已禁用。无法满足这些条件时只能完成 fake/integration gate，不能把 live smoke 标记为通过。

- 运行 `npm run typecheck`、全部单元测试、fake gateway 测试、coordinator integration、JSONL event-log integration 和 live smoke。
- 专门验证跨进程 `proper-lockfile` sidecar lock、binding CAS、capability mismatch、agentArgs payload gate、exact resume、pane disposition、JSONL replay/尾行损坏和 workspace/tab 归属。
- 检查没有遗漏的外部 `pi-herdr` import、`herdr_delegate` 调用、旧 Markdown record 读取/导入/转换、latest-session fallback 或 shell 字符串执行。
- 运行 `git diff --check`、`npm pack --dry-run`，确认 `git status --short` 只包含预期文件。
- 更新 README 的已实施状态和剩余风险；未验证的能力不能写成已完成事实。

## 5. 测试矩阵

| 测试层 | 必须覆盖 |
| --- | --- |
| Pure unit | 配置优先级、role/profile、normal argv、coordinator argv、exact resume、JSONL schema/replay、seq/messageId/物理行号、幂等、非法尾行、redaction、状态转换 |
| Gateway unit | argv 数组、`shell: false`、显式 env 合并、AbortSignal/timeout、JSON 解析、capability error、busy、prompt stalled、pane move/create/close |
| Event-log integration | JSONL append/replay、schema 校验、read-after-write、尾行损坏、幂等重试、`proper-lockfile` sidecar lock、并发 writer、event-log identity 和 linked event log |
| Record reader | 共享只读路径归属、消息范围和敏感值校验；不提供 Codex/Claude 专用插件或 child 写入能力 |
| Leaf integration | 单 stage 完整闭环、wait checkpoint、session mismatch、completion contract、DONE 后 pane policy |
| Coordinator integration | binding race、coordinator reuse/resume、busy queue、bounded ACK、FIFO、stage isolation、人工阻塞、恢复 |
| Package checks | extension registration、active skill 移除、npm pack、安装后 tool discovery |
| Live smoke | Herdr 0.8+、真实 Codex/Claude/Pi profile、实际 agentArgs、new-tab、exact resume、workspace/tab 归属 |

每个 public class/method 必须有参数和返回值注释；难以直读的状态转换、锁协议、恢复决策和 pane disposition 必须有简短代码注释。新增测试应在实现注释中保留 `TEST:<file>[<case>]` 入口。

## 6. 关键决策门

| 决策点 | 通过标准 | 未通过处理 |
| --- | --- | --- |
| Herdr CLI contract | 0.8+ 命令、参数和 JSON shape 已由 probe/fixture 验证 | 停在 Phase 0，返回 capability gap，不猜测输出 |
| Pi tool API | 目标 Pi 版本的 `registerTool`、TypeBox schema 和 execute contract 已验证 | 记录替代入口决策，不进入默认 extension registration |
| Process/env boundary | `spawn` 的 argv/cwd/env/timeout 行为和 Herdr child-env 传递已验证；否则拒绝依赖 env 的配置 | 只允许 exact-session guard 路径；非空 profile env 返回 capability error |
| Coordinator unattended policy | 有明确且可验证的非交互策略 | 只允许 `BLOCKED` 启动结果，不创建假定可运行的 coordinator |
| Typecheck baseline | `tsconfig.json`、`typescript` devDependency 和 `npm run typecheck` 已建立并通过 | 不进入 Phase 2 runtime 集成 |
| Record concurrency | `proper-lockfile` sidecar lock 下 JSONL append/replay、幂等和物理行范围可证明串行 | 不进入 coordinator implementation |
| Coordinator wake-up | busy 时无并发 prompt，idle 时有 bounded ACK | 修正状态机，不以模型 prompt 作为唯一保证 |
| Exact recovery | kind/source/value 三元组和 pane 状态均可验证 | 返回 `BLOCKED`/`PARTIAL`，禁止 latest-session/fresh fallback |
| Package migration | 新版本 active owner 唯一；旧 Skill 不注册为新版本入口，旧 Markdown record 不支持 | 停止默认 runtime 切换，保留旧版本 package 回滚方案 |

## 7. 回滚与发布顺序

1. 先在独立 Herdr workspace 完成 fake、integration 和 live smoke；确认 JSONL event log、session identity、pane disposition 和旧 Skill active entry 已移除。
2. 发布新版本 package，active owner 只有 TypeScript extension；旧 `.md` communication file 不在发布包的 runtime 流程中。
3. 若新 engine 出现问题，回滚整个 package 到旧版本并重新加载旧配置；新版本 runtime 不读取、导入或转换旧 Markdown record，也不要求删除新版本留下的 JSONL/binding/pipeline 文件。
4. 回滚后保留失败 JSONL event log、binding 和 capability/error 信息；旧版本是否能理解这些新状态不作假设，不自动重跑已完成 stage。
5. 发布前执行 `git diff --check`、完整测试、`npm pack --dry-run`，并确认没有自动提交或推送要求之外的 Git 操作。

## 8. 完成定义

代码实现只有同时满足以下条件才算完成：

- 单 stage leaf delegation 已通过 fake、integration 和 live smoke；
- coordinator 能创建、复用、精确恢复，并在竞争提交下保持单实例；
- `QUEUED`/`ACCEPTED`、transport/semantic state 和 pane policy 均有测试证明；
- pipeline stage 具备独立 session/JSONL event log、checkpoint、恢复和最终汇总；
- runtime 不调用两个外部 `pi-herdr` 工具，所有 Herdr 副作用经过 `HerdrCliGateway`；
- package、README、配置示例、旧 Skill 回滚材料和 design/plan 文档一致；
- `git diff --check`、`npm run typecheck`、测试和 npm pack 均通过；
- 未验证的 Herdr、Pi 或跨进程行为已明确记录为风险，而不是标记为 DONE。

## 9. Communication Payload 解耦专项计划

> 状态：实施中。direct-v2 prompt、双 anchor、leaf/coordinator relay 和基础测试已落地；live smoke、完整兼容回滚演练和发布门禁仍未完成。本专项不删除 JSONL event log，只把 JSONL 从 Leaf Child 的输入通道改为 parent/coordinator 的持久化状态日志。
>
> 本节覆盖前文对 pointer relay、child event-log 读取和旧模块拆分的预研描述；前文保留为当前实现 baseline，后续实现以本节 direct-v2 contract、兼容边界和验收门槛为准。

### 9.1 目标与边界

本专项采用以下职责划分：

| 层 | 目标职责 |
| --- | --- |
| Herdr prompt | 直接传递本次 task/continuation 的完整、已校验任务载荷 |
| Pipeline/stage JSONL | 保存 intent、队列、checkpoint、observation、result、error、recovery 和幂等身份 |
| Parent/coordinator | 读取、追加、重放 JSONL，并负责结果校验和状态推进 |
| Leaf Child | 只读取 Herdr prompt，执行工作并返回 completion contract；不读取或写入 communication JSONL |

本专项不改变以下语义：

- `pipeline.status`、`recover` 和 coordinator recovery 仍以 JSONL replay 为权威；
- `messageId`、`eventId`、`resultKey`、attempt、fencing token 和 exact `agent_session` 仍必须持久化；
- child 输出仍由 Parent 或 Coordinator 捕获后写入 `observation`/`result`/`error` event；
- child 不获得通信文件插件、写权限或状态 owner 身份；
- 旧 Markdown record 仍不读取、不导入、不转换。

`communicationFile` 在第一版解耦中保留为 event-log 路径和诊断 metadata。`relayTransport` 明确区分 transport 版本：缺少该字段的既有 event 一律按 `pointer-v1` replay 和匹配，`herdr-direct-v2` 只表示新的 direct prompt。文档和新代码注释应逐步使用“event log”表达其状态职责，不再把它描述为 Leaf Child 的必需通信通道；兼容期结束后仍可保留字段名，但不得再用它作为 direct child 的输入依赖。

### 9.2 目标数据流

#### Direct delegate

```text
Parent
  W stage event log: event-log-created / task
  -> Herdr: 完整 direct task prompt

Leaf Child
  R Herdr prompt
  W 工作区、自己的 session 和终端输出
  -> completion contract

Parent
  R child pane/session 输出
  W stage event log: observation / result / error / pane-disposition
```

#### Pipeline

```text
Main Parent
  W pipeline event log: task
  W durable inbox: queue pointer
  -> Herdr: 完整 pipeline request 或完整 control payload

Coordinator
  R Herdr direct payload + durable inbox/event log 做 identity 对照
  W pipeline event log: accepted / stage status / final result
  W stage event log: task / checkpoint / result
  -> Herdr: 完整 stage task/continuation prompt

Leaf Child
  R Herdr stage prompt
  W 工作区、自己的 session 和终端输出

Coordinator
  R child pane/session 输出
  W stage event log 和 pipeline event log
```

Parent 到 Coordinator 的 inbox、answer、stop、recover 都使用 direct-v2 payload；durable inbox 仍然保留，用于排队、重启恢复和去重。Coordinator 到 stage child 的任务和 continuation 复用 direct leaf 的同一 prompt builder，不再存在第二套 pointer envelope。Coordinator 仍必须以 durable JSONL 的 `pipelineId`、`messageId`、attempt 和 fence 校验 prompt，不能只相信 Herdr 传输文本。

Herdr 负责传输，JSONL 负责持久化；任何一方都不能单独替代另一方：Herdr 不提供 pipeline durable queue/replay，JSONL 也不再作为 child 的输入依赖。

### 9.3 Event 与 Prompt Contract

1. 在创建 handoff event 前，构造经过 schema、identity、敏感值和 transport 校验的 normalized relay payload；同一份完成校验且已脱敏的载荷同时用于 event audit 和 Herdr prompt，禁止先对 prompt 单独拼接再写另一份 event。
2. 新 task/continuation/control event 在 payload 中记录 `relayTransport: "herdr-direct-v2"`；缺少该字段的旧 event 固定解释为 `pointer-v1`，不能因为缺少字段而切换到 direct 解析，也不能因新增字段而破坏 replay。
3. direct-v2 prompt 以固定、非 `-` 开头的 identity block 开始，至少包含以下精确字段：
   ```text
   RELAY TRANSPORT: herdr-direct-v2
   MESSAGE ID: <message-id>
   MESSAGE TYPE: task|continuation|control
   ```
   monitor 的 direct anchor 是 `(relayTransport, messageId)`；legacy pointer-v1 anchor 仍是 `(communicationFile, messageId)`。两种 anchor 必须按 persisted `relayTransport` 选择，不能接受任意一个看起来相似的 marker。
4. direct prompt 至少包含 transaction、stage id/role/occurrence、attempt、fencing token、execution fence（适用时）、task 或 continuation、cwd、资源/访问约束、agent profile 的必要执行约束、固定的 `STATUS`/`SUMMARY`/`VALIDATION` completion contract，以及禁止递归 delegate 的约束。结构化字段使用确定性的序列化规则；task 正文与 metadata 分隔，避免正文中的 marker 被当成当前 relay anchor。
5. direct prompt 不要求 child 打开 `communicationFile`，也不发送 `MESSAGE SEQ`、`MESSAGE LINES`、event-log 解析规则或 parent-owned recovery 责任。`communicationFile` 只作为 parent/coordinator 的路径、审计和旧 relay 兼容 metadata。
6. prompt 发送前执行 UTF-8 byte length 和行数限制。首个版本固定 `64 KiB` 和 `400` 行上限；超限在创建 pane、append handoff relay event 和 Herdr send 之前返回结构化 `BLOCKED`，已有 event log 只记录 validation error，不得创建 child。Herdr CLI 仍使用 argv 数组、`shell: false`；必须验证 direct prompt 的固定 header、必要的 `--` 分隔方式和换行不会被 CLI 重新解释。
7. prompt 和 event 都不得包含密码、Token、Cookie、私钥或其他凭据。除现有 key-based payload redaction 外，对最终发送的 prompt 执行敏感值检查；检查失败时 fail closed，并只记录长度/hash 和错误类别，不记录原文。必须在文档中明确 argv/进程列表对非凭据敏感 task 的可见性限制。
8. `AgentTurnMonitor`、`currentRelayOutput`、Pi session fallback 和 `reconcilePartial` 必须支持 direct-v2 与 pointer-v1 双 anchor。direct-v2 需要保留 foreign-marker rejection；pointer-v1 只为兼容期内已发出的 relay 保留。direct-v2 的 completion 解析不得依赖 `COMMUNICATION FILE`。
9. direct prompt 回显可能占用 terminal read window；`readAgent` 应支持按 prompt line count 请求足够的 recent lines，至少覆盖 direct prompt、completion contract 和固定余量。若 completion 超出窗口，必须产生有原因的 `PARTIAL`，不能静默当作无输出。
10. 保留 Herdr 的 `wait: false`、exact session、baseline、monitor 和 semantic-DONE-gated pane disposition；本专项只替换 child payload 的来源，但会同步更新上述 identity anchor 和 terminal/session parser。

### 9.4 实施阶段

#### Phase A：先冻结 direct relay contract 与设计文档

- 先更新 `design.md` 中与 child relay、completion anchor、event-log ownership 冲突的条款，以及 README 的对应契约；在这些文档完成前不得合并 direct relay runtime。`design.md` 仍是实现 contract，Phase A 负责先改变 contract，再实现代码。
- 新增 parent-owned 的 direct prompt builder，输入为已校验的 normalized task/continuation/control payload，输出固定、可测试的 Herdr prompt。prompt 首行固定为 `RELAY TRANSPORT: herdr-direct-v2`，随后输出精确 `MESSAGE ID` 和 `MESSAGE TYPE` identity block。
- 将现有 `buildRelayEnvelope` 拆成 direct-v2 prompt builder 与 pointer-v1 legacy matcher/reader 两部分；新任务不再生成 `COMMUNICATION FILE`、`MESSAGE SEQ` 或 `MESSAGE LINES` child-facing 指令，但兼容期不得删除旧 marker 的解析能力。
- 在 `AgentTurnObservationInput`、relay runtime 和 persisted payload 中增加明确的 `relayTransport` 传播；缺省值只解释为 pointer-v1。更新 `hasRelayAnchor`、`currentRelayOutput`、Pi session matcher 和 `reconcilePartial`，按 transport 选择 anchor，并继续拒绝 foreign marker。
- 为 `HerdrCliGateway` 增加 direct prompt 的 UTF-8 byte/line bound、非 `-` 固定 header 和换行稳定性验证；明确 shell-free argv、`--` 分隔方式（以实际 Herdr CLI probe 结果为准）和 prompt 超限时的结构化 `BLOCKED` 行为。
- 对最终发送 prompt 执行敏感值检查，只记录长度/hash/错误类别；验证 terminal read window 能覆盖最大允许 prompt 与 completion contract，必要时让 `readAgent` 接受按 prompt 行数计算的 `lines`。
- 保留 `messageId`、result identity、transport 和 session metadata 的日志记录，以便发送后监控、旧 relay 兼容和失败恢复；不要把 task 原文写入 debug 输出。

**门槛：** design/README contract 已更新；fake gateway 能证明 direct prompt 携带完整 task、completion contract 和 identity block，prompt 不含 child 文件读取指令；direct/legacy 两种 anchor、超限 BLOCKED、leading-dash、换行、敏感值和 terminal read-window 单元测试通过。

#### Phase B：切换 direct leaf

- 调整 `DelegateEngine.run`：在创建 pane 或发送前先渲染并校验 direct prompt；校验通过后 append handoff event，再使用同一份 normalized payload 和已验证 prompt 通过 `HerdrCliGateway.prompt` 发送。超限、敏感值或序列化失败不得创建 child。
- 从 persisted handoff event 读取 `relayTransport`：新 event 使用 direct-v2，旧 event 缺省走 pointer-v1。continuation、timeout、partial、Pi session fallback 和 exact-session reconciliation 必须沿用原 transport，不得把旧 in-flight relay 改写成新 transport。
- 调整 direct-v2 continuation、timeout、partial 和 exact-session reconciliation，使重试/恢复仍使用新的 direct prompt，不重复创建 child、不替换 exact session；旧 pointer-v1 只使用只读兼容 matcher。
- 保留 parent 对 stage event log 的读写和 replay；删除 Leaf Child 侧的文件读取前提，而不是删除 event log。完成判定继续要求 semantic `DONE`，不能只相信 Herdr idle/done 状态。
- 为 direct delegate 增加成功、blocked、partial、session mismatch、prompt failure、结果幂等、foreign marker rejection、direct/legacy late reconciliation 和 read-window overflow 测试。

**门槛：** direct leaf 在 child 无法访问通信目录的 fake/integration 场景下仍能完成；direct-v2 与旧 pointer-v1 relay 都能按各自 anchor 得到正确 completion；所有最终状态仍能从 event log replay 得到。

#### Phase C：切换 pipeline coordinator relay

- 调整 Parent 到 Coordinator 的 `promptInbox`、`sendBootstrap` 和 `COORDINATOR_BOOTSTRAP`：durable inbox 继续负责队列和恢复，但 Herdr 直接携带完整、已校验的 pipeline request。Coordinator 只执行一次约定的 `pipeline.coordinator` action，不再被提示去读取 `INBOX FILE` 或自行解析 pointer。
- 调整 `promptControl`：answer、stop、recover 的 control payload 一律 inline 发送，包含 action、pipeline identity、message identity、target 和已校验参数；不再产生新的 `EVENT LOG`/`MESSAGE SEQ`/`MESSAGE LINES` pointer-v1 control prompt。
- Coordinator 收到 prompt 后，必须使用 `pipelineId`、`messageId`、event identity、attempt 和 fence 对照 durable JSONL，再追加 `accepted` 或 control event；不能只相信 Herdr prompt 文本。
- Coordinator 到 stage child 的 task/continuation 已由 Phase B 的 `DelegateEngine` direct builder 覆盖，本阶段只移除剩余 coordinator-specific pointer 文案并验证 transport metadata，不再维护第二套 relay 实现。
- 保留 busy queue、bounded ACK、FIFO、stage isolation、ready-wave 并发和 stale control/fence 校验；明确 Main Parent 只读取 pipeline status/progress，stage child 不读取 pipeline 总日志或 stage JSONL。

**门槛：** pipeline 在 coordinator busy、重启、重复 prompt、人工 answer/stop/recover 和 stage partial 场景下，状态仍只由 JSONL replay 得出；Coordinator 和 stage child 都不需要打开 communication 文件；control prompt 也能被重复投递而不重复执行。

#### Phase D：收缩旧生成路径并同步文档

- 盘点实际存在的 `buildRelayEnvelope`、`COORDINATOR_BOOTSTRAP`、`promptInbox`、`sendBootstrap`、`promptControl`、`COMMUNICATION FILE`、`MESSAGE LINES` 和 child-facing JSONL 文案引用；`record-reader.ts`、`coordinator-prompt.ts` 若不存在，不创建新模块，只在计划和文档中明确“不需要”。
- 删除新任务生成 pointer-v1 的路径；保留一个有明确 sunset 边界的 parent/coordinator-only legacy matcher，用于兼容期内已发出的旧 relay。不得把 legacy reader 重新暴露为 Codex/Claude child 插件。
- 同步 `design.md`、README、测试命名、debug 字段和 release/rollback material，使“JSONL 是 parent/coordinator 状态日志、Herdr 是 child 载荷传输、anchor 按 transport 版本选择”成为唯一描述。
- `communicationFile` 继续出现在结果和诊断 metadata 中，但 child-facing direct prompt 不再要求读取它；`observation.relayAnchor` 必须标明 direct-v2 或 legacy-v1 语义，不能只用布尔值掩盖版本。

#### Phase E：兼容、发布与回滚

- 新 task/continuation/control event 使用 `relayTransport: "herdr-direct-v2"`；已有 JSONL 无该字段时固定按 pointer-v1 replay，不能因缺少新字段而损坏恢复。
- 在一个 release 内保留 pointer-v1 的只读 matcher 和 Pi fallback。已经发出的旧 relay 不主动重发、不替换 exact session；其 monitor 继续按 legacy anchor 观察。新的 task、continuation、retry 和 control 不得再产生 pointer-v1。
- 发布前建立 in-flight 边界：升级后 direct-v2 和 legacy-v1 均可观察；回滚前必须停止新 direct-v2 投递，并将仍在运行的 direct-v2 stage 显式记录为 `PARTIAL`/`BLOCKED` recovery 状态。旧 runtime 不得尝试在 direct-v2 stage 上发送 pointer prompt 或替换 exact session。
- 若无法证明旧 runtime 不会继续 direct-v2 stage，则该版本不允许回滚，只能先完成/终止这些 stage 后再切换。回滚后保留新 JSONL、binding 和 pipeline 文件，不让旧版本猜测、转换或自动重跑新 transport 状态。
- direct relay 的 live smoke 未通过时，按上述边界停止 direct-v2、保留 failure evidence，再回滚整个 package/runtime；旧 pointer-v1 in-flight relay 继续使用兼容 matcher。

### 9.5 测试与验收矩阵

| 测试层 | 验收内容 |
| --- | --- |
| Prompt unit | direct task/continuation/control payload、identity block、completion contract、确定性序列化、CRLF/换行、leading-dash、64 KiB/400 行边界、超限 BLOCKED、敏感值扫描；断言不存在 `COMMUNICATION FILE`、`MESSAGE SEQ`、`MESSAGE LINES` 或 child 文件读取指令 |
| Monitor unit | direct-v2 `(relayTransport,messageId)` anchor、legacy-v1 `(communicationFile,messageId)` anchor、foreign marker rejection、缺失 anchor 的 BLOCKED/PARTIAL 语义、terminal-wrapped marker 和 completion-shaped task text |
| Leaf integration | child 只收到 Herdr prompt；通信目录不可读时仍能从 prompt 完成；prompt 回显包含 `MESSAGE ID` 但无 `COMMUNICATION FILE` 时仍能 `DONE`；completion 超出 read window 时得到有原因的 bounded `PARTIAL` |
| Pipeline integration | Parent/Coordinator/Leaf 的读写边界、inbox、direct request、inline answer/stop/recover、accepted、stage result 和最终汇总；重复 control prompt 不重复执行 |
| Recovery | Parent/coordinator 重启、重复 relay、混合旧/新 event replay、direct-v2 session fallback、pointer-v1 session fallback、exact-session continuation、stale attempt/fence 和 late reconciliation |
| Failure injection | Herdr prompt 未送达、child 未响应、prompt timeout、argv/E2BIG 或超限、leading-dash、敏感值拒绝、JSONL 写入失败、结果重复、event-log 尾行损坏和 terminal read-window overflow |
| Rollback | 旧 runtime 遇到 direct-v2 active/partial stage 时明确拒绝或按发布边界停止；不得将 direct-v2 stage 改发 pointer prompt，不得替换 exact session |
| Live smoke | 真实 Codex/Claude/Pi child 不读取 communication JSONL，仍能完成 direct leaf 和至少一个 pipeline stage；至少覆盖一次旧 pointer-v1 in-flight 观察和一次 direct-v2 late reconciliation |
| Documentation | `design.md`、README、plan、debug 字段、测试命名和 rollback material 对 transport/version、state ownership、anchor 和 child boundary 的描述一致 |

### 9.6 完成定义

本专项只有同时满足以下条件才算完成：

- 新 direct delegate、pipeline stage 和 coordinator control 都通过 Herdr 直接接收完整且已校验的 payload；
- Leaf Child 不需要读取或写入 communication JSONL；
- Parent/coordinator 仍是唯一 JSONL 状态和结果 writer，所有 event-log append 都受现有锁、幂等和 replay 规则约束，只读 replay 不修改文件；
- direct-v2 与 pointer-v1 的 anchor、completion parser、Pi session fallback 和 exact-session late reconciliation 均有版本化测试；
- `pipeline.status`、`recover`、answer/stop/recover、exact-session continuation 和 semantic-DONE-gated pane disposition 行为不回归；
- 失败、超时、重复 prompt、超限 payload 和 coordinator 重启不会导致隐式重复执行；
- 回滚边界已经演练，旧 runtime 不会在 direct-v2 stage 上发送 pointer prompt 或替换 exact session；
- 文档不再把 JSONL 文件读取描述为 child 通信插件或必需能力；
- `npm run typecheck`、完整测试、live smoke、`git diff --check` 和 `npm pack --dry-run` 均通过。
