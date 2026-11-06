/**
 * 远程 ShellExecutor 的语义验收。
 *
 * 真实启动端侧 daemon 并通过 WebSocket 交互，因此覆盖的是端到端行为，而不只是
 * 云端侧的单元逻辑。断言与 `dsh-bash-local` 的契约对齐。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RemoteHub } from '../src/cloud/hub.ts'
import { RemoteShellExecutor } from '../src/cloud/shell-remote.ts'

const PORT = 7820
const TOKEN = 'shell-test'
const WORK_ROOT = '/tmp'
/** 等待 daemon 建立连接的轮询上限。 */
const CONNECT_TIMEOUT_MS = 10_000

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

let hub: RemoteHub
let daemon: ChildProcess
let shell: RemoteShellExecutor

beforeAll(async () => {
  hub = new RemoteHub({ port: PORT, token: TOKEN })
  await sleep(400)

  // 构建产物是 lib/daemon.js；测试从这里启动真实 daemon。
  daemon = spawn(process.execPath, [
    new URL('../lib/daemon.js', import.meta.url).pathname,
    '--endpoint', `ws://127.0.0.1:${PORT}`,
    '--token', TOKEN,
    '--work-root', WORK_ROOT,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  daemon.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(`[daemon] ${String(chunk)}`) })

  const deadline = Date.now() + CONNECT_TIMEOUT_MS
  while (!hub.connected && Date.now() < deadline) await sleep(100)
  if (!hub.connected) throw new Error(`daemon 未在 ${CONNECT_TIMEOUT_MS}ms 内连接`)

  shell = new RemoteShellExecutor(hub, {
    cwd: WORK_ROOT,
    timeoutMs: 30_000,
    maxTimeoutMs: 60_000,
    maxOutputBytes: 4096,
  })
}, CONNECT_TIMEOUT_MS + 5_000)

afterAll(async () => {
  shell.dispose()
  daemon.kill('SIGTERM')
  await sleep(300)
  hub.close()
})

describe('端侧连接', () => {
  it('daemon 主动连上云端', () => {
    expect(hub.connected).toBe(true)
  })
})

describe('resolve 的默认值与上限', () => {
  it('补全缺省字段', () => {
    const spec = shell.resolve({ command: 'echo hi' })
    expect(spec.workdir).toBe(WORK_ROOT)
    expect(spec.timeoutMs).toBe(30_000)
    expect(spec.onExpiry).toBe('kill')
    expect(spec.stdoutMaxBytes).toBe(4096)
  })

  it('把超时收敛到上限', () => {
    expect(shell.resolve({ command: 'x', timeoutMs: 999_999 }).timeoutMs).toBe(60_000)
  })
})

describe('执行语义', () => {
  it('回传退出码与两个输出流', async () => {
    const result = await (await shell.execute(shell.resolve({
      command: 'echo OUT; echo ERR >&2; exit 5',
    }))).result()

    expect(result.exitCode).toBe(5)
    expect(result.stdout.text).toContain('OUT')
    expect(result.stderr.text).toContain('ERR')
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it('记忆化前台投影', async () => {
    const execution = await shell.execute(shell.resolve({ command: 'true' }))
    const first = await execution.result()
    expect(await execution.result()).toBe(first)
  })

  it('在指定工作目录执行', async () => {
    const result = await (await shell.execute(shell.resolve({
      command: 'pwd',
      workdir: WORK_ROOT,
    }))).result()
    expect(result.stdout.text.trim()).toBe(WORK_ROOT)
  })

  it('拒绝工作根之外的目录', async () => {
    const result = await (await shell.execute(shell.resolve({
      command: 'pwd',
      workdir: '/home',
    }))).result()
    // 边界检查让命令不执行，因此不会有 /home 的输出
    expect(result.stdout.text).not.toContain('/home')
  })
})

describe('超时与中止的首因分类', () => {
  it('超时标记为 timedOut 而非 aborted', async () => {
    const result = await (await shell.execute(shell.resolve({
      command: 'sleep 30',
      timeoutMs: 800,
    }))).result()
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
  })

  it('调用方中止标记为 aborted 而非 timedOut', async () => {
    const controller = new AbortController()
    const execution = await shell.execute(shell.resolve({
      command: 'sleep 30',
      signal: controller.signal,
      timeoutMs: 20_000,
    }))
    setTimeout(() => { controller.abort() }, 500)
    const result = await execution.result()
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
  })
})

describe('输出读取', () => {
  it('readOutput 是消费式游标', async () => {
    const execution = await shell.execute(shell.resolve({ command: 'echo A; echo B' }))
    await execution.result()
    await sleep(200)

    const first = execution.readOutput()
    const second = execution.readOutput()
    expect(first.delta).toContain('A')
    expect(second.delta).toBe('')
  })

  it('observed 是非消费式偏移读取', async () => {
    const execution = await shell.execute(shell.resolve({ command: 'echo A; echo B' }))
    await execution.result()
    await sleep(200)

    const first = execution.observed.stdout.readFrom(0)
    const second = execution.observed.stdout.readFrom(0)
    expect(first.text).toContain('A')
    expect(second.text).toBe(first.text)
  })

  it('超出上限的 stdout 标记为截断', async () => {
    const result = await (await shell.execute(shell.resolve({
      command: 'seq 1 5000',
      stdoutMaxBytes: 200,
    }))).result()
    expect(result.stdout.truncated).toBe(true)
  })
})

describe('进程终止', () => {
  it('kill 结束进程且只生效一次', async () => {
    const execution = await shell.execute(shell.resolve({ command: 'sleep 30', timeoutMs: 20_000 }))
    await sleep(600)

    expect(execution.kill()).toBe(true)
    await Promise.race([execution.done, sleep(8_000)])
    expect(execution.status).not.toBe('running')
    expect(execution.kill()).toBe(false)
  })
})