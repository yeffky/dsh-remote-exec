# Proposal: 为远程 Ticket 准备并定位项目工作区

## Why

Superagent 当前创建 Ticket 目录后只执行 `mkdir`。远程 Shell 插件把云端 Ticket 路径映射为 daemon `workRoot` 下的目录名，因此命令虽然在 daemon 上运行，却可能落在空目录或插件仓库中。Worker 随后检查到错误的 Git `origin`，无法找到目标项目。

用户希望远程执行像常规 coding agent 一样：任务启动时进入正确的项目工作区，Worker 可以在项目文件中使用 `rg`、`grep` 查找实现。执行主机上的项目地址应由 daemon 解析，云端不需要知道操作者电脑上的路径。

## What Changes

- 用 Superagent 的仓库标识和 Ticket id 建立远程目录身份，避免把插件默认 `cwd` 的最后一段误当作项目目录。
- daemon 在 `workRoot/<ticket-id>` 下运行自己的 `--prepare` 命令，为 Ticket 从配置仓库创建独立检出。
- 将准备所需的仓库标识等非敏感执行变量安全传递给 daemon 自己的 `--prepare`；不把任意 worker 环境变量或凭据传给准备命令。
- 启动命令前验证 Ticket 目录是预期仓库的检出，并从该目录启动 Worker shell。
- 未找到仓库、仓库不匹配或准备失败时立即失败，不继续在空目录或插件仓库执行。

## Impact

- Affected specs: `remote-execution`, `execution-sandbox`
- Affected code: remote shell 路径解析、daemon Ticket 准备流程、daemon 配置与集成测试
- Depends on: Superagent 现有 GitHub Source 仓库设置及 worker shell 已携带的 `DSH_SUPERAGENT_GITHUB_REPOSITORY`；daemon 主机需有该仓库的 Git 读取权限
- Superagent source code/config: 不需要修改。Superagent 的 Executor `prepare` 在云端 execution root 运行，不负责准备 daemon 上的远程工作树；远程 Ticket 工作区由本插件 daemon 的 `--prepare` 负责

## Exclusions

- 不实现 Router 的磁盘搜索或多仓库智能路由。
- 不扫描 daemon 的任意目录；仓库来源由已配置的仓库标识确定。
- 不实现远程文件系统工具或新的 UI。
- 不在 prepare 命令、daemon 配置或模型上下文中存放 GitHub 长期凭据；私有仓库仍依赖 daemon 主机上现有的 Git 凭据，直到凭据代理实现。
