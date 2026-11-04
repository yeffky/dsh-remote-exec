# Proposal: 远程 shell 执行

## Why

super-agent 的第 5.2 节要求把「计算」放在云端、把「重状态的执行环境」留在原地。已有一个原型验证了可行性：云端触发一条 `hostname`，命令实际在操作者的开发机上执行，返回了该机的主机名。

原型证明了链路通，但它是单文件、无沙箱、无审计的探索代码，不能作为插件发布。本变更把它整理成可维护、可测试的 DSH 插件。

用户价值：操作者可以在云端 Agent 上使用自己真实的开发环境——未提交的改动、私有 SDK、内网依赖——而不必把环境搬上云。

## What Changes

- 新增 `dsh-remote-exec` 插件，实现 `ctx.shell` 的远程版本。
- 保持 `ctx.subprocess` 为本地实现，使 setup 探测与会话恢复不受影响。
- 执行主机侧提供一个无状态 daemon：只执行命令、回传结果，不保存会话。
- 输出按字节上限截断，断连即失败，不自动重试。
- 每一次执行都进入审计日志。

## Impact

- Affected specs: `remote-execution`（新增）、`execution-policy`（审计）、`execution-sandbox`（后续接入）
- Affected code: 全新仓库的 `src/shell`、`src/transport`、`src/daemon`
- Depends on: 无（这是第一个变更）
- Excludes: 文件系统远程化、沙箱、网络策略、审批、多设备调度

## Why `ctx.shell` and not `ctx.subprocess`

已在原型阶段验证过：替换 `ctx.subprocess` 会让两个控制面也跑到执行主机上，导致

- setup 探测找不到本机的 `gh` / `lark-cli`
- 会话恢复在 `agent-preset-registry` 内抛出 `Cannot read properties of undefined (reading 'parent')`

替换 `ctx.shell` 只影响 `tool-bash`，控制面全部留在云端。这是本设计的核心约束。