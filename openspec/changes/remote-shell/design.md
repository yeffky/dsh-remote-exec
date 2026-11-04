# Design: 远程 shell 执行

## Context

DSH 把 shell 拆成两个 seam：

- `ctx.subprocess`（5 个抽象方法）：进程级能力，被 setup、会话恢复、shell 三方共用
- `ctx.shell`（2 个抽象方法）：bash 执行语义，只被 `tool-bash` 使用

`dsh-bash-local` 的实现路径是 `ShellExecutor → ctx.subprocess`。**替换 `ctx.subprocess` 会波及控制面**（原型的实测结论），因此本设计替换 `ctx.shell`。

## Goals

- 命令在执行主机上按 `dsh-bash-local` 的语义执行。
- 控制面（setup、会话恢复、凭据）留在云端。
- 连接断开时快速失败，不挂起，不静默回退本地。
- 输出量有界，不因一条 `cat large.log` 拖垮通道。

## Non-goals

- 不实现 `spawnTerminal`（终端仿真），超出本变更范围。
- 不做 stdin 的流式双向转发；一次性 stdin 足够。
- 不做多设备调度。

## Wire protocol

WebSocket，JSON 文本帧。连接方向是**执行主机主动连云端**，因此端侧可以在 NAT 之后，云端不需要知道端侧地址。

请求：

```json
{ "jsonrpc": "2.0", "id": 7, "method": "shellExec",
  "params": { "spawnId": "sh-…", "command": "npm test", "cwd": "/work/ticket-1",
              "env": { "CI": "1" }, "graceMs": 3000, "stdin": null } }
```

事件（无 id，由 `spawnId` 归属）：

```json
{ "jsonrpc": "2.0", "method": "spawned", "params": { "spawnId": "sh-…", "pid": 1234 } }
{ "jsonrpc": "2.0", "method": "output",  "params": { "spawnId": "sh-…", "stream": "stdout",
                                                      "offset": 0, "data": "<base64>" } }
{ "jsonrpc": "2.0", "method": "exit",    "params": { "spawnId": "sh-…", "exitCode": 0, "signal": null } }
```

**`offset` 是必须的**：云端据此实现 `ShellProcess.observed` 的非消费式偏移读取，也便于识别重复帧。

## Mapping to ShellExecutor

| DSH 契约 | 实现 |
| --- | --- |
| `resolve(request)` | 填默认值与上限（`timeoutMs`、`stdoutMaxBytes`、`onExpiry`），与 `dsh-bash-local` 一致 |
| `execute(spec)` | 返回 live handle；内部异步发起 `shellExec` |
| `done` | `exit` 事件到达时 settle |
| `readOutput()` | 消费式游标，合并 stdout 与 stderr |
| `observed.stdout/stderr` | 按 `readFrom(fromByte)` 独立读取 |
| `kill()` | 发 `terminate`，端侧 SIGTERM → graceMs → SIGKILL |
| `result()` | 记忆化的前台投影，含 `timedOut` / `aborted` 首因分类 |

## Output bounding

端侧按块推送，云端维护保留窗口（默认 2 MiB）。超出时：

- `readOutput()` 的增量截断至 `stdoutMaxBytes`，返回 `lossy: true`
- `result().stdout.truncated = true`

**为什么要限**：一条 `tail -f` 或 `cat 1GB.log` 会让通道饱和，后续命令排队。与 `dsh-subprocess-local` 的 `maxOutputBytes` 语义对齐。

## Failure behavior

| 情况 | 行为 |
| --- | --- |
| 无执行主机连接 | `spawn` 立即失败，错误名「没有可用的执行主机」 |
| 命令执行中主机断开 | `done` settle 为错误，`readOutput` 保留已有输出 |
| 云端进程重启 | 端侧 daemon 重连；旧进程被端侧清理（`--die-with-parent` 同理） |
| 超时 | 端侧杀进程树，结果 `timedOut: true` |
| 调用方 abort | 同上，结果 `aborted: true` |

**不自动重试**：命令可能有副作用，重试会重复副作用。

## Sandbox placeholder

本变更**不实现**沙箱。`sandboxMode` 先返回 `workspace-write` 以满足 `dsh-permission-presets` 的组合要求，并在 daemon 内做 cwd 边界检查作为最低保证。

真正的 bubblewrap 沙箱在 `execution-sandbox` 变更中替换这一层。**在此之前，这个声明是不完整的保证**，README 必须写清楚。

## Why the host connects out

```
执行主机 ──WebSocket──► 云端
```

好处：端侧不需要公网 IP、不需要端口映射、NAT 后可用。代价：云端无法主动联系一台离线设备，任务只能等它上线。这与 super-agent「可能间歇在线的个人机器」的描述一致。

## Open questions

- 多设备时如何选择目标主机？本变更只支持一台。
- 是否需要压缩输出？当前不做，文本量大时后续可加。
- `spawnTerminal` 是否需要？当前 DSH 的 `tool-terminal` 依赖它，但 super-agent 的 worker preset 不挂载该工具。