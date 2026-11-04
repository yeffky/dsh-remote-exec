# Tasks

## 1. 插件骨架

- [ ] 1.1 建立仓库骨架：`package.json`（插件形态，无 `dsh.bundle`）、`tsdown.config.ts`、`tsconfig.json`、`vitest.config.ts`。
- [ ] 1.2 定义插件入口，注册 `ctx.shell`；确认不替换 `ctx.subprocess`。满足 `remote-execution`：The agent loop keeps control-plane work。
- [ ] 1.3 单元测试：插件加载后 `ctx.shell` 是远程实现，`ctx.subprocess` 仍是本地实现。

## 2. 传输层

- [ ] 2.1 实现协议类型与序列化（`shellExec` / `terminate` / `stdin` 请求；`spawned` / `output` / `exit` 事件）。满足 `remote-execution`：Shell work runs on the execution host。
- [ ] 2.2 实现云端 WebSocket 服务与连接管理，单主机场景。满足同上。
- [ ] 2.3 实现端侧连接与重连，端侧主动外连。满足 `remote-execution`：A host reconnects。
- [ ] 2.4 单元测试：协议往返、未知方法被拒绝、重复 `spawnId` 被拒绝。

## 3. ShellExecutor 实现

- [ ] 3.1 `resolve()` 填默认值与上限，与 `dsh-bash-local` 对齐。满足 `remote-execution`：Shell semantics match the local executor。
- [ ] 3.2 `execute()` 返回 live handle，含 `done` / `readOutput` / `observed` / `kill` / `result`。满足同上。
- [ ] 3.3 `readOutput` 实现消费式游标；`observed` 实现独立偏移读取。满足 `remote-execution`：Output is read incrementally。
- [ ] 3.4 `result()` 实现 `timedOut` / `aborted` 首因分类与记忆化。满足 `remote-execution`：A command times out / A caller aborts a command。
- [ ] 3.5 单元测试：逐条覆盖上述场景，语义与 `dsh-bash-local` 对照。

## 4. 输出边界与断连

- [ ] 4.1 实现保留窗口与 `maxOutputBytes` 截断，标记 `lossy` 与 `truncated`。满足 `remote-execution`：Output volume is bounded。
- [ ] 4.2 断连时把在跑的命令 settle 为错误，禁止本地回退。满足 `remote-execution`：Host disconnection is fail-closed。
- [ ] 4.3 单元测试：大输出不撑爆通道；断开后新命令立即失败。

## 5. 端侧 daemon

- [ ] 5.1 实现命令执行、流式回传、超时与 abort 的进程树终止。满足 `remote-execution`：A command times out。
- [ ] 5.2 实现 cwd 边界检查作为临时最低保证，并在 `sandboxMode` 注释中标注其不完整性。满足 `execution-sandbox`：Writes are confined to the ticket directory（部分）。
- [ ] 5.3 daemon 无状态：重启后不恢复任何会话，只重新连接。满足 `remote-execution`：A host reconnects。
- [ ] 5.4 集成测试：真实启动 daemon，执行命令并校验输出与退出码。

## 6. 在真实 DSH 上验证

- [ ] 6.1 在 super-agent profile 中加载插件，确认启动无 warning。满足 `remote-execution`：The agent loop keeps control-plane work。
- [ ] 6.2 端到端：飞书触发「执行 hostname」，断言返回值是执行主机的主机名。满足 `remote-execution`：A command runs on the execution host。
- [ ] 6.3 反向验证：不启动 daemon 时命令失败且不本地回退。满足 `remote-execution`：No host is connected。

## 7. 文档

- [ ] 7.1 写 README：安装、配置、daemon 启动、已知限制（无沙箱、单设备）。
- [ ] 7.2 写 `docs/001-architecture.md`，含 seam 选择理由与信任边界。
- [ ] 7.3 在 README 明确：`sandboxMode` 当前为不完整声明，安全边界靠 `execution-sandbox` 变更补齐。