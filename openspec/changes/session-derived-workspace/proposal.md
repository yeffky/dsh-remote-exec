# 提案：从 DSH Session 自动解析 Superagent Ticket 工作区

## Why

专用 Superagent Shell profile 开启 `requireWorkspaceContext` 后，当前插件要求每次 Shell 请求都携带 GitHub 仓库和 Ticket 两项环境变量。Superagent 的 prompt/assignment 环境并不保证被 DSH Shell 作为请求环境传递，因此 worker shell 请求会因缺少字段而失败。Superagent 已绑定 GitHub 仓库；用户不应在每条任务或命令中重复补充上下文，也不应在插件配置中重复绑定仓库。

DSH 的 managed shell environment 会在每次工具调用中自动提供 `DSH_SESSION_ID`。Superagent Worker Session 使用 `worker-<ticketId>` 形式的 Session id；Superagent 的 `orchestrator` Source Context 提供当前部署的 GitHub 仓库绑定。插件可读取现有绑定、从当前 Session 提取 Ticket 身份，并将两者组合成 workspace RPC。独立于 Superagent 使用时，插件配置中的仓库只作为可选备用值。

## What Changes

- 从可选的 Superagent `orchestrator` 服务读取已有 GitHub Source 仓库绑定；保留可选静态仓库配置供独立部署回退使用。
- 当请求没有显式 workspace 仓库或 Ticket 字段时，从 `DSH_SESSION_ID=worker-<ticketId>` 自动解析 Ticket id，并结合 Superagent 已绑定的仓库形成 workspace。
- 显式请求环境字段优先；缺失字段只允许用可信 Session id、Superagent 仓库绑定或独立插件备用配置补齐。
- 保留通用 Shell Session 的旧行为。专用 Superagent profile 在无法解析 Ticket 或仓库时继续 fail closed，不回退到默认 cwd。
- 更新使用文档，说明 Superagent 部署不需要重复配置仓库；独立部署可使用备用仓库字段。

## Scope

- Affected specs: `remote-execution`
- Affected code: remote Shell workspace resolution, shell plugin configuration, and documentation
- No Superagent source changes, daemon RPC changes, or daemon filesystem discovery

## Exclusions

- 多仓库路由、从磁盘扫描猜测项目、Router 或 Worker 的行为调整。
- 对 DSH `shellEnv`、`DSH_SESSION_ID` 生成方式或 Superagent Session 命名规则的修改。
- 凭据传递、私有仓库认证或 daemon prepare 语义变更。
