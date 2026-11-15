# Design: Session 来源的 Ticket 工作区

## Context

RemoteShellExecutor 目前仅从 `env` 与 `dshEnv` 中读取 `DSH_SUPERAGENT_GITHUB_REPOSITORY` 和 `DSH_SUPERAGENT_TICKET`。当二者都缺失时，通用模式执行普通 Shell RPC；严格模式拒绝执行。当前 `dirFor` 的 basename 兼容路径不能作为 Ticket 身份来源，因为云端工作目录名称不等于 Ticket id。

DSH managed shell environment 会在每次 Bash/PowerShell 工具调用中提供 `DSH_SESSION_ID`。Superagent Worker Session id 约定为 `worker-<ticketId>`。Superagent 的 `orchestrator` Source Context 提供当前 deployment 的 GitHub 仓库绑定；独立 Shell 部署仍可设置静态 `workspaceRepository` 作为备用值。

## Decisions

1. 通过 Cordis 的可选 `ctx.get('orchestrator')` 读取 Superagent 的 GitHub Source Context `deployment.repository`，不把 Superagent 变成普通 Shell profile 的强依赖。
2. 显式 `DSH_SUPERAGENT_GITHUB_REPOSITORY` 优先，其次使用 Superagent 当前绑定，最后才使用可选 `workspaceRepository` 备用值。只有在请求上下文有显式仓库/Ticket 信息，或 Session id 可解析为 Worker Ticket 时，才构造 workspace。
3. 缺少 Ticket 环境变量时，只有 `DSH_SESSION_ID` 完整匹配 `worker-<ticketId>` 且 Ticket id 符合 daemon 接受的标识格式，插件才用该 id 补齐 Ticket。
4. 仓库环境变量缺失时，插件先用 Superagent 当前 GitHub Source 绑定补齐；该服务不可用时才用独立部署配置中的 `workspaceRepository`。不得从命令文本、云端工作目录 basename、daemon 文件系统或 Git remote 猜仓库。
5. 如果只解析出部分身份，或有效仓库与 Ticket 身份格式错误，返回明确错误，不发起 RPC。
6. 若请求既无显式 Superagent 身份也非 Worker Session，通用 profile 保持普通 Shell 语义；启用 `requireWorkspaceContext` 时拒绝请求。
7. 构造出的 workspace 继续走现有 `workspaceExec` 协议、Ticket id 目录映射、daemon prepare 和 origin 校验；不改变协议或执行主机安全边界。

## Trust boundary

- `DSH_SESSION_ID` 是 DSH managed shell environment 提供的调用方 Session 身份，不由模型命令文本决定。
- Superagent repository 使用其 `orchestrator` 服务提供的 GitHub Source deployment 绑定；Superagent 不可用时，独立配置可提供 `workspaceRepository` 备用值。
- 每条请求的显式仓库环境值仍可用于兼容旧版 Superagent；如果提供，则由 daemon 的 workspace 验证流程校验实际 origin。
- 云端绝对路径仍不发送给 daemon；仓库、Ticket id 与必要元数据才发送。

## Failure behavior

| 情况 | 行为 |
| --- | --- |
| Worker Session id 合法且 Superagent GitHub Source 已绑定仓库 | 用 Ticket id 与 Superagent 已绑定仓库发送 workspace RPC |
| 非 Superagent 部署配置了 `workspaceRepository` | 用 Ticket id 与备用仓库配置发送 workspace RPC |
| 显式仓库/Ticket 环境值齐全 | 保持现有解析行为，显式值优先 |
| Worker Session id 合法但无可用仓库来源 | 返回缺少 workspace repository 的明确错误 |
| `worker-` 后缀不符合 Ticket 标识格式 | 不将其作为 Ticket 身份；严格模式拒绝，通用模式按普通 Shell 处理 |
| 非 Worker Session 且没有显式 workspace | 严格模式拒绝，通用模式按普通 Shell 处理 |
| 仓库标识不是 `owner/name` | 拒绝请求，不访问 daemon |

## Test seam

主要 seam 是 `RemoteShellExecutor.execute` 接收的 `ShellExecSpec` 与 RemoteHub RPC 之间的边界。后续行为验收应观察发出的 RPC 方法、workspace、dir 和错误结果：从 Worker Session 自动构造 workspace；从 Superagent 绑定取得仓库；独立模式使用备用配置；显式环境值优先；同一仓库下不同 Ticket id 保持隔离；Router/普通 Session 在严格与通用配置下按预期拒绝或走普通 RPC；无效仓库和 Ticket 在 daemon 调用前拒绝。

## Alternatives considered

- 修改 Superagent 为每个 Ticket 注册 shell environment contributor：超出本插件仓库的改造边界。
- 从 `workdir` 最后一段推断 Ticket id：该名称可能是短名或云端 workspace 目录名，不是稳定的 Ticket 主键。
- 让 daemon 扫描目录或从已有 Git remote 猜仓库：会引入隐式路由并扩大 daemon 可见的宿主状态。
- 强制把仓库再写进 Shell 插件配置：会造成 Superagent Source 与插件配置重复，且可能不一致。
