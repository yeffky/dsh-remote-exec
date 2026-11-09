# Design: Ticket 项目工作区发现

## Context

Shell 请求目前包含云端 `workdir`，插件把它变成 daemon `workRoot` 下的相对目录标识。daemon 只在目标目录不存在时运行 `--prepare`；没有准备命令时会创建空目录。路径与仓库身份目前没有关联，因此执行器可能在错误的工作树里运行。

## Decision

1. 插件从 `dshEnv` 提取 GitHub 仓库标识、Ticket id 和必要的非敏感 PR 元数据。云端绝对路径 `DSH_SUPERAGENT_DIR` 不发送给 daemon。
2. 对带 Superagent workspace context 的请求，插件用 Ticket id 作为远程目录标识；不会使用 shell 插件配置的默认 `cwd` 覆盖它。专用 Superagent profile 可设置 `requireWorkspaceContext`，确保缺少仓库/Ticket 元数据时失败；普通 Shell profile 保持旧映射行为。
3. daemon 校验 repository 与 ticket 标识，并把 Ticket 目录解析到 `workRoot/<ticket-id>`。目标目录首次使用时必须运行 daemon 自己的 `--prepare`；Superagent 的 Executor `prepare` 在云端 execution root 执行，不能替代这一步。
4. daemon 的 `--prepare` 只接收 allowlist 中的仓库、Ticket、短名和 PR ref 等字段。部署命令按仓库标识从 GitHub clone 到 `$DIR`；Worker 的当前目录就是该检出，因此可以直接运行 `rg --files`、`grep` 等项目内检索命令。
5. daemon 在每条 workspace 命令前核对 Git remote。准备失败、路径越界、仓库不匹配或缺少 `--prepare` 时，命令失败关闭；不得退回到 daemon 当前目录、插件仓库或空目录。
6. Worker 环境中的 `DSH_SUPERAGENT_DIR` 被改写为 daemon 上的 Ticket 目录；其他云端绝对路径不发送。daemon 不枚举或暴露 Ticket 之外的宿主机路径。

## Trust boundary

- 云端会话看到仓库标识、Ticket 工作目录和命令输出；不需要看到 Windows 主机路径或 daemon 的完整文件系统布局。
- daemon 看到仓库标识和 Ticket 工作路径。每个 Ticket 有独立 clone；但当前版本没有 OS 级文件系统沙箱，远程命令仍以 daemon 用户权限运行，可访问 workRoot 之外的路径。
- prepare 命令只接收显式允许的仓库变量，不能继承 daemon 环境中的 GitHub token、SSH agent 或其他凭据。
- Superagent 的 Executor `prepare` 在云端 execution root 运行，不能用于创建 daemon 工作树。本插件 daemon 的 `--prepare` 才是远程准备 seam。
- 私有仓库 clone 使用 daemon 主机已有的 Git credential helper；本变更不通过环境变量或命令行传入长期凭据。此限制会在凭据代理实现后移除。

## Failure behavior

| 情况 | 行为 |
| --- | --- |
| 仓库标识格式非法或未配置 | 拒绝准备并返回明确错误 |
| daemon 未配置 `--prepare` | Superagent workspace 命令拒绝执行 |
| clone 或其他 prepare 失败 | 保留错误输出，不在空目录执行 |
| Ticket clone 的 remote 与配置不符 | 拒绝执行 |
| Ticket 路径通过 `..` 或符号链接越界 | 拒绝执行并返回工作区边界错误 |
| daemon 断连 | 按现有远程 Shell 失败关闭规则处理，不切换到云端或其他仓库 |

## Test seam

以 `ctx.shell` 的端到端执行边界作为主要测试 seam：启动真实 daemon，配置临时 Ticket 根目录，触发一次 Shell 请求，再验证 daemon `--prepare` 得到允许列表里的仓库标识、工作目录、仓库身份、文件搜索、越界拒绝及失败关闭行为。单元测试只覆盖仓库标识解析和路径约束等纯逻辑。

## Alternatives considered

- **让 Router 扫描 daemon 整个文件系统并猜项目**：拒绝。当前每个 Superagent deployment 已配置单一 GitHub repository；仓库身份由配置确定，Worker 只需在该仓库内搜索代码。
- **只修改默认 `cwd`**：拒绝。Superagent 每个 Ticket 都有自己的标识；默认 cwd 无法保证仓库存在，也不能隔离并发 Ticket。
- **继续在 prepare 失败后创建空目录**：拒绝。会让与项目无关的命令成功，并再次掩盖仓库错配。
