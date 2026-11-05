#!/usr/bin/env node
/**
 * 路径 B 验收：远程 ShellExecutor 的语义是否与 bash-local 一致。
 *
 * 覆盖：
 *   1. resolve 补默认值与上限
 *   2. execute 在端侧真实执行，stdout/stderr/退出码正确
 *   3. result() 的 timedOut / aborted 首个原因分类
 *   4. readOutput 是消费式，observed 是非消费式
 *   5. kill() 终止端侧进程
 */
import { spawn as spawnProc } from 'node:child_process'
import { RemoteHub } from '../src/cloud/hub.mjs'
import { RemoteShellExecutor } from '../src/cloud/shell-remote.mjs'

const PORT = 7820
const TOKEN = 'shell-test'
let pass = 0, fail = 0
const check = (n, c, d = '') => { c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`)) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

console.log('=== 路径 B 验收：远程 ShellExecutor ===\n')

const hub = new RemoteHub({ port: PORT, token: TOKEN })
await sleep(400)

const daemon = spawnProc(process.execPath, [
  new URL('../src/daemon/daemon.mjs', import.meta.url).pathname,
  '--endpoint', `ws://127.0.0.1:${PORT}`, '--token', TOKEN,
], { stdio: ['ignore', 'ignore', 'pipe'] })
daemon.stderr.on('data', d => process.stderr.write('[daemon] ' + d))

for (let i = 0; i < 50 && !hub.connected; i++) await sleep(100)
check('端侧 daemon 已连接', hub.connected)

const shell = new RemoteShellExecutor(hub, { cwd: '/tmp', timeoutMs: 30_000, maxTimeoutMs: 60_000, maxOutputBytes: 4096 })

// --- 1. resolve 默认值 ---
{
  const spec = shell.resolve({ command: 'echo hi' })
  check('resolve 补 workdir', spec.workdir === '/tmp', spec.workdir)
  check('resolve 补 timeoutMs', spec.timeoutMs === 30_000, String(spec.timeoutMs))
  check('resolve 补 onExpiry', spec.onExpiry === 'kill', spec.onExpiry)
  check('resolve 补 stdoutMaxBytes', spec.stdoutMaxBytes === 4096, String(spec.stdoutMaxBytes))

  const capped = shell.resolve({ command: 'x', timeoutMs: 999_999 })
  check('resolve 截断超时到上限', capped.timeoutMs === 60_000, String(capped.timeoutMs))
}

// --- 2. 基本执行 ---
{
  const spec = shell.resolve({ command: 'echo OUT; echo ERR >&2; exit 5' })
  const exec = await shell.execute(spec)
  const res = await exec.result()
  check('退出码正确', res.exitCode === 5, String(res.exitCode))
  check('stdout 正确', res.stdout.text.includes('OUT'), JSON.stringify(res.stdout.text))
  check('stderr 正确', res.stderr.text.includes('ERR'), JSON.stringify(res.stderr.text))
  check('未超时', res.timedOut === false)
  check('未中止', res.aborted === false)
  check('result() 记忆化', (await exec.result()) === res)
}

// --- 3. 工作目录 ---
{
  // daemon 未传 --work-root 时默认 /tmp，边界检查要求 workdir 落在其下
  const spec = shell.resolve({ command: 'pwd', workdir: '/tmp' })
  const res = await (await shell.execute(spec)).result()
  check('workdir 生效', res.stdout.text.trim() === '/tmp', res.stdout.text.trim())
}

// --- 3b. 越界目录被拒绝 ---
{
  const spec = shell.resolve({ command: 'pwd', workdir: '/home' })
  const res = await (await shell.execute(spec)).result()
  check('越界 workdir 被拒绝', !res.stdout.text.includes('/home'), JSON.stringify(res.stdout.text))
}

// --- 4. 超时分类 ---
{
  const spec = shell.resolve({ command: 'sleep 30', timeoutMs: 800 })
  const res = await (await shell.execute(spec)).result()
  check('超时被标记 timedOut', res.timedOut === true, JSON.stringify({ t: res.timedOut, a: res.aborted }))
  check('超时不算 aborted', res.aborted === false)
}

// --- 5. abort 分类 ---
{
  const ac = new AbortController()
  const spec = shell.resolve({ command: 'sleep 30', signal: ac.signal, timeoutMs: 20_000 })
  const exec = await shell.execute(spec)
  setTimeout(() => ac.abort(), 500)
  const res = await exec.result()
  check('abort 被标记 aborted', res.aborted === true, JSON.stringify({ t: res.timedOut, a: res.aborted }))
  check('abort 不算 timedOut', res.timedOut === false)
}

// --- 6. readOutput 消费式 vs observed 非消费式 ---
{
  const spec = shell.resolve({ command: 'echo A; echo B' })
  const exec = await shell.execute(spec)
  await exec.result()
  await sleep(200)
  const r1 = exec.readOutput()
  const r2 = exec.readOutput()
  check('readOutput 消费式（第二次为空）', r2.delta === '', JSON.stringify(r2.delta))
  check('readOutput 首次有内容', r1.delta.includes('A'), JSON.stringify(r1.delta))

  const obs1 = exec.observed.stdout.readFrom(0)
  const obs2 = exec.observed.stdout.readFrom(0)
  check('observed 非消费式', obs1.text === obs2.text, JSON.stringify([obs1.text, obs2.text]))
  check('observed 含输出', obs1.text.includes('A'))
}

// --- 7. kill ---
{
  const spec = shell.resolve({ command: 'sleep 30', timeoutMs: 20_000 })
  const exec = await shell.execute(spec)
  await sleep(600)
  const killed = exec.kill()
  check('kill 返回 true', killed === true)
  await Promise.race([exec.done, sleep(8000)])
  check('kill 后进程结束', exec.status !== 'running', exec.status)
  check('kill 后 kill() 返回 false', exec.kill() === false)
}

// --- 8. stdout 上限 ---
{
  const spec = shell.resolve({ command: 'seq 1 5000', stdoutMaxBytes: 200 })
  const res = await (await shell.execute(spec)).result()
  check('stdout 被截断标记', res.stdout.truncated === true, String(res.stdout.text.length))
}

shell.dispose()
daemon.kill('SIGTERM')
await sleep(300)
hub.close()
console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)