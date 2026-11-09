# 001 Architecture

本文说明本插件替换了哪个 seam、为什么，以及它建立的信任边界。

## 一、为什么替换 `ctx.shell` 而不是 `ctx.subprocess`

DSH 把进程能力拆成两个 seam：

| seam | 抽象方法数 | 消费者 |
| --- | --- | --- |
| `ctx.subprocess` | 5 | setup 探测、会话恢复、`dsh-bash-local` |
| `ctx.shell` | 2 | 只有 `tool-bash` |

`dsh-bash-local` 的实现路径是 `ShellExecutor → ctx.subprocess`。因此替换任一 seam
都能让 bash 变远程，但影响的消费者数量差别很大。

原型阶段两种都试过，实测差异如下：

| 替换对象 | setup 探测 | 会话恢复 | bash 执行 |
| --- | --- | --- | --- |
| `ctx.subprocess` | ❌ 跑到执行主机，找不到 `gh` / `lark-cli` | ❌ 在 `dsh-agent-preset-registry` 内抛 `Cannot read properties of undefined (reading 'parent')` | ✅ |
| `ctx.shell` | ✅ 留在云端 | ✅ 留在云端 | ✅ |

第一条的失败原因很直接：setup 探测的是**云端**那份 CLI 凭据，跑到执行主机上
自然找不到。第二条是 DSH 内部的 fiber 树假设，属于控制面的实现细节。

结论：**控制面留在云端，数据面（执行）下沉到执行主机。** `ctx.shell` 正好是
这条分界线。

## 二、模块划分

```
src/
├── cloud/                 云端（agent loop 所在机器）
│   ├── plugin-hub.ts      连接服务，注册 ctx.remoteExecHub
│   ├── plugin-shell.ts    注册 ctx.shell 的远程实现
│   ├── hub.ts             WebSocket server、Peer、事件分发
│   └── shell-remote.ts    RemoteShellExecutor：seam 的具体实现
├── daemon/daemon.ts       执行主机（无状态，只执行与回传）
└── shared/protocol.ts     两端共用的消息契约
```

### 为什么 hub 是独立 service

`worker preset` 运行在 cordis 的 `isolate` 作用域内，看不到主 Context 上的普通
服务。原型用 `globalThis` 单例绕开了这个限制，但那绕过了 cordis 的生命周期：
多实例、卸载、测试都会出问题。

现在把连接拆成独立条目 `dsh-remote-exec/hub`，由它注册 `ctx.remoteExecHub`；
shell 插件通过 `inject: ['remoteExecHub']` 依赖它。缺少 hub 时条目保持 pending，
而不是自行监听端口。

代价是部署时多一条配置；收益是连接有明确的所有者，可被单独卸载。

## 三、信任边界

```
┌─ 高信任（云端）──────────────────────┐
│  Agent Loop                          │
│  ├─ 模型、Policy、Ticket、会话状态    │
│  ├─ 提供商凭据（当前仍在此）          │
│  └─ 远程 seam 的云端一半              │
└──────────────┬───────────────────────┘
               │ WebSocket（执行主机主动外连）
               │ 共享令牌鉴权
┌──────────────▼───────────────────────┐
│  执行主机（较低信任）                 │
│  ├─ daemon：只执行命令、回传结果      │
│  ├─ 工作目录（work-root）             │
│  └─ 操作者的真实环境                  │
└──────────────────────────────────────┘
```

### 这个边界的假设

**当前实现假设云端可信、执行主机上的命令不可信。** 这不同于 Grok Bot
（它假设执行主机就是用户本人），理由是执行主机上运行的是**可能被提示词注入
影响的命令**。

super-agent 原文第 8.4 节把两条风险列为开放问题：

1. 云端被攻破 → 其连接的全部设备面临被控制
2. 端侧凭据进入模型上下文 → 正常执行中就会泄露

本插件**尚未解决这两条**。当前状态与对应的后续变更：

| 风险 | 现状 | 对应变更 |
| --- | --- | --- |
| 云端被攻破后可任意驱动执行主机 | 共享令牌鉴权，无其他约束 | `execution-sandbox` |
| 端侧持有真实凭据 | 凭据仍在执行主机的 git 配置里 | `credential-proxy` |
| 命令可读写工作目录外的文件 | 只有 work-root 路径检查 | `execution-sandbox` |
| 命令可访问任意网络 | 无网络策略 | `execution-sandbox` |

### `sandboxMode` 声明的真实含义

`plugin-shell.ts` 向 DSH 报告 `sandboxMode: 'workspace-write'`，因为
`dsh-permission-presets` 要求一个具体模式才能组合。

**这个声明目前不完整。** daemon 只做了一件事：拒绝 `cwd` 不在 `work-root`
之下的请求。命令一旦跑起来，它可以读写该目录树之外的一切，也可以访问任意网络。

代码注释与 README 都标注了这一点，避免被误读为安全保证。

## 四、失败语义

| 情况 | 行为 |
| --- | --- |
| 没有执行主机连接 | `execute()` 立即抛错，**不**回退本地 |
| 命令执行中连接断开 | `done` 以错误收敛，已收到的输出仍可读 |
| 云端重启 | daemon 自动重连；云端侧在跑的命令状态丢失 |
| 超时 | daemon 杀进程树；结果 `timedOut: true` |
| 调用方 abort | 同上；结果 `aborted: true` |
| 命令有副作用 | **不自动重试**，重试会重复副作用 |

「不回退本地」是刻意的：静默回退会让调用方以为命令在目标环境执行，实际却
跑在别处，这种错误比直接失败危险得多。

## Ticket 工作区映射

Superagent worker 的 Shell 请求含有仓库标识和 Ticket id 时，云端改用
`workspaceExec` RPC，并以 Ticket id 作为远程目录标识。插件不把云端的
`DSH_SUPERAGENT_DIR` 绝对路径发给 daemon；daemon 在自己的 `workRoot` 下创建
该 Ticket 目录，并用本机 `--prepare` 命令把对应 GitHub 仓库检出到这里。

daemon 只把仓库、Ticket、短名和 PR ref 等 allowlist 字段传给准备命令。准备
完成后，每条命令都会核对 GitHub `origin` 是否匹配配置的仓库，并把远程
`DSH_SUPERAGENT_DIR` 改写为 daemon 上的 Ticket 路径。缺少 `--prepare`、检出
失败或 origin 不匹配时，命令会失败，不会在空目录或插件仓库中继续。

普通 Shell Session 没有 Superagent workspace metadata 时，保留原有 `cwd` 与
相对目录映射行为。旧 daemon 不认识 `workspaceExec`，会以 unknown method 拒绝，
不会把 Ticket id 当普通目录执行。

每个 Ticket 都会独立 clone；daemon 不会自动清理已结束 Ticket 的目录。当前
`workRoot` 检查只约束命令的当前目录，不是 OS 文件系统沙箱；命令仍以 daemon
用户权限运行，可以访问其他可读写路径。

## 五、输出传输

daemon 按 64 KiB 分块推送，每块带整流的字节偏移。云端保留每个流最近 2 MiB，
超出后旧块被丢弃并在读取时标记 `lossy`。

两个读取接口方向不同：

- `readOutput()`：**消费式**游标，把 stdout 与 stderr 增量合成一个 delta，
  受 `stdoutMaxBytes` 限制
- `observed.stdout/stderr`：**非消费式**，按 `readFrom(fromByte)` 独立读取，
  不偷走 `readOutput` 的字节

这与 `dsh-subprocess-local` 的 collect 语义一致，也是
`shell-remote.ts` 里最容易写错的部分——`result()` 必须在 settle 之后才读取
超时/中止标志，否则会拿到调用时刻的旧快照。

## 六、未实现

- `spawnTerminal`：终端仿真，超出当前范围
- 多设备调度：`hub.peer()` 只取第一台可用设备
- 文件系统远程化：`ctx.fs` 仍指向云端，因此执行主机上的文件对 Executor
  不可见 —— 这是当前最大的功能缺口
- **daemon Git 凭据仍在执行主机**：`--prepare` 的 clone 使用执行主机已有的 Git
  credential helper。凭据代理尚未实现前，不要把 PAT 写进 prepare 命令或环境。
- **Ticket clone 不自动回收**：已结束 Ticket 的目录留在 `--work-root`，需要运维侧
  定期清理。
- 压缩：输出量大时未压缩
