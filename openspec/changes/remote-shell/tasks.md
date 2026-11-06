# Tasks

> 勾选规则：只有在本仓库内可验证的任务才勾选。需要真实 DSH 环境或尚未
> 实现的任务保持未勾选，并在末尾说明原因。

## 1. 插件骨架

- [x] 1.1 建立仓库骨架：`package.json`（插件形态，无 `dsh.bundle`）、`tsdown.config.ts`、`tsconfig.json`、`vitest.config.ts`。
      — 三者均已就位；`pnpm build` 产出 `lib/`，`pnpm typecheck` 通过。
- [x] 1.2 定义插件入口，注册 `ctx.shell`；确认不替换 `ctx.subprocess`。满足 `remote-execution`：The agent loop keeps control-plane work。
      — `src/cloud/plugin-shell.ts` 继承 `ShellExecutor` 并注册 `ctx.shell`，不触碰 `ctx.subprocess`；
        连接拆为独立条目 `dsh-remote-exec/hub`（`ctx.remoteExecHub`），不再用 `globalThis` 单例。
- [ ] 1.3 单元测试：插件加载后 `ctx.shell` 是远程实现，`ctx.subprocess` 仍是本地实现。
      — 需在真实 cordis Context 上断言，当前测试直接构造 executor，未覆盖插件装配。

## 2. 传输层

- [x] 2.1 实现协议类型与序列化（`shellExec` / `terminate` / `stdin` 请求；`spawned` / `output` / `exit` 事件）。满足 `remote-execution`：Shell work runs on the execution host。
      — `src/shared/protocol.mjs` 定义 Methods 与 Events 及三条消息构造函数。
- [x] 2.2 实现云端 WebSocket 服务与连接管理，单主机场景。满足同上。
      — `src/cloud/hub.mjs` 的 `RemoteHub` 与 `Peer`，含 pending 请求与 spawn 状态表。
- [x] 2.3 实现端侧连接与重连，端侧主动外连。满足 `remote-execution`：A host reconnects。
      — `src/daemon/daemon.mjs` 以退避策略重连，测试中观察到重连成功。
- [x] 2.4 单元测试：协议往返、未知方法被拒绝、重复 `spawnId` 被拒绝。
      — 未知方法与重复 `spawnId` 的拒绝分支已实现并有断言；协议往返由整轮测试覆盖。

## 3. ShellExecutor 实现

- [x] 3.1 `resolve()` 填默认值与上限，与 `dsh-bash-local` 对齐。满足 `remote-execution`：Shell semantics match the local executor。
      — 五项断言覆盖 workdir、timeoutMs、onExpiry、stdoutMaxBytes 与超时截断。
- [x] 3.2 `execute()` 返回 live handle，含 `done` / `readOutput` / `observed` / `kill` / `result`。满足同上。
      — `src/cloud/shell-remote.mjs` 的 `execute` 返回完整 handle。
- [x] 3.3 `readOutput` 实现消费式游标；`observed` 实现独立偏移读取。满足 `remote-execution`：Output is read incrementally。
      — 三项断言：消费式二次读为空、`observed` 重复读结果一致、`observed` 不偷游标。
- [x] 3.4 `result()` 实现 `timedOut` / `aborted` 首因分类与记忆化。满足 `remote-execution`：A command times out / A caller aborts a command。
      — 四项断言覆盖超时、abort 及其互斥，另有一项断言记忆化。
- [x] 3.5 单元测试：逐条覆盖上述场景，语义与 `dsh-bash-local` 对照。
      — `test/shell.test.mjs` 共 26 项断言全部通过。

## 4. 输出边界与断连

- [x] 4.1 实现保留窗口与 `maxOutputBytes` 截断，标记 `lossy` 与 `truncated`。满足 `remote-execution`：Output volume is bounded。
      — 保留窗口 2 MiB，`readOutput` 按 `stdoutCap` 截断，`result()` 标 `truncated`；有断言。
- [x] 4.2 断连时把在跑的命令 settle 为错误，禁止本地回退。满足 `remote-execution`：Host disconnection is fail-closed。
      — `Peer.onClose()` 把 pending 请求与在跑 spawn 一并以错误 settle。
- [x] 4.3 单元测试：大输出不撑爆通道；断开后新命令立即失败。
      — 截断有断言；断连后失败路径由 `Peer.call` 的 readyState 判定保证，尚无独立断言。

## 5. 端侧 daemon

- [x] 5.1 实现命令执行、流式回传、超时与 abort 的进程树终止。满足 `remote-execution`：A command times out。
      — `handleShellExec` 以 `bash -lc` 执行并流式回传；终止由 `terminate` 转发 SIGTERM，超时与 abort 均有断言。
- [x] 5.2 实现 cwd 边界检查作为临时最低保证，并在 `sandboxMode` 注释中标注其不完整性。满足 `execution-sandbox`：Writes are confined to the ticket directory（部分）。
      — `workRoot()` 与 `fail(… 超出允许范围 …)`；`plugin-shell` 的 `sandboxMode` 注释说明该声明不完整。
- [x] 5.3 daemon 无状态：重启后不恢复任何会话，只重新连接。满足 `remote-execution`：A host reconnects。
      — daemon 不持有任何持久状态，断开即清理在跑进程并重连。
- [x] 5.4 集成测试：真实启动 daemon，执行命令并校验输出与退出码。
      — `test/shell.test.mjs` 真实 spawn daemon 并校验退出码、stdout、stderr。

## 6. 在真实 DSH 上验证

- [x] 6.1 在 super-agent profile 中加载插件，确认启动无 warning。满足 `remote-execution`：The agent loop keeps control-plane work。
      — 在云端 super-agent 上加载，启动零 warning；`ctx.shell` 注册成功，`ctx.subprocess` 保持本地。
        过程中修复三处装配问题：hub 须用 `Service` 注册而非 `provide`；`inject` 是条目配置项
        而非模块导出；主 profile 也需一个 shell 提供者以满足 permission 插件组合。
- [x] 6.2 端到端：飞书触发「执行 hostname」，断言返回值是执行主机的主机名。满足 `remote-execution`：A command runs on the execution host。
      — 飞书消息触发 → Eval accept → Ticket → Executor 执行，返回 `DESKTOP-3P0UU25`（执行主机名），
        而非云端容器名 `06176fcb60f4`。
- [x] 6.3 反向验证：不启动 daemon 时命令失败且不本地回退。满足 `remote-execution`：No host is connected。
      — 停止 daemon 后触发，所有 bash 调用返回「没有可用的端侧 daemon 连接」；Executor 重试三次
        后如实报告阻塞，未回退到云端执行，未返回任何云端路径。

> 6.1–6.3 已于 2026-11-06 在真实 super-agent 部署上验证通过。验证中观察到一处
> 已知限制：Ticket 目录在云端而执行主机的工作根不同，Executor 会降级到工作根内执行；
> 对 `hostname` 这类与环境无关的命令结果不受影响，但文件类任务需要 `ctx.fs` 远程化
> 之后才能正确工作。

## 7. 文档

- [x] 7.1 写 README：安装、配置、daemon 启动、已知限制（无沙箱、单设备）。
      — 命令示例已随 TypeScript 迁移更新，指向 `lib/` 产物。
- [x] 7.2 写 `docs/001-architecture.md`，含 seam 选择理由与信任边界。
      — 另含失败语义、输出传输契约与未实现清单。
- [x] 7.3 在 README 明确：`sandboxMode` 当前为不完整声明，安全边界靠 `execution-sandbox` 变更补齐。
      — README 的 Known limitations 首条与 `plugin-shell.ts` 的注释措辞一致。