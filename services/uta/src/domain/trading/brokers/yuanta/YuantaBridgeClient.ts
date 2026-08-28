import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { yuantaRuntimeActivePath, yuantaRuntimeReleasesRoot, type YuantaRuntimePointer } from '@/core/yuanta-runtime.js'
import type { YuantaBridgeConfig, YuantaRpcResponse } from './yuanta-types.js'

export class YuantaBridgeClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>()

  constructor(private readonly config: YuantaBridgeConfig) {}

  async init(): Promise<void> {
    if (this.child) return
    const bridgePath = this.config.bridgePath
      ?? process.env['OPENALICE_YUANTA_BRIDGE_PATH']
      ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'OpenAlice.YuantaBridge.dll')
    const runtimeDir = this.config.runtimeDir
      ?? process.env['OPENALICE_YUANTA_RUNTIME_DIR']
      ?? await resolveInstalledRuntime()
    if (!runtimeDir) throw new Error('Yuanta SPARK runtime is not installed. Install or repair Yuanta support from Trading.')
    const args = [bridgePath, ...(runtimeDir ? ['--runtime-dir', runtimeDir] : [])]
    const child = spawn('dotnet', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line))
    child.stderr.on('data', () => { /* Vendor logs are intentionally not forwarded: they may contain account data. */ })
    child.once('exit', (code) => this.failAll(new Error(`Yuanta Bridge exited (${code ?? 'unknown'})`)))
    child.once('error', (err) => this.failAll(err))
    await this.call('initialize', {
      environment: 'uat',
      account: this.config.account,
      password: this.config.password,
      acceptVendorLicense: true,
    }, 30_000)
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child) return
    await this.callOn(child, 'shutdown', {}, 5_000).catch(() => undefined)
    child.kill()
  }

  call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.child) return Promise.reject(new Error('Yuanta Bridge is not initialized'))
    return this.callOn<T>(this.child, method, params, timeoutMs)
  }

  private callOn<T>(child: ChildProcessWithoutNullStreams, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const id = randomUUID()
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Yuanta Bridge ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (value) => resolvePromise(value as T), reject, timer })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (err) => {
        if (!err) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  private handleLine(line: string): void {
    let response: YuantaRpcResponse
    try { response = JSON.parse(line) as YuantaRpcResponse } catch { return }
    const pending = this.pending.get(response.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(response.id)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new Error(response.error?.message ?? 'Yuanta Bridge request failed'))
  }

  private failAll(err: Error): void {
    this.child = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }
}

async function resolveInstalledRuntime(): Promise<string | null> {
  try {
    const pointer = JSON.parse(await readFile(yuantaRuntimeActivePath(), 'utf8')) as YuantaRuntimePointer
    if (pointer.schemaVersion !== 1 || !/^[A-Za-z0-9._-]+$/.test(pointer.release)) return null
    const root = resolve(yuantaRuntimeReleasesRoot(), pointer.release, 'YuantaSparkAPI_CSharp')
    if (!(await stat(resolve(root, 'YuantaSparkAPI.dll'))).isFile()) return null
    return root
  } catch { return null }
}
