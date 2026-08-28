import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolve } from 'node:path'
import {
  YUANTA_RUNTIME_SHA256,
  YUANTA_RUNTIME_SIZE,
  YUANTA_RUNTIME_URL,
  YUANTA_RUNTIME_VERSION,
  yuantaRuntimeActivePath,
  yuantaRuntimeReleasesRoot,
  yuantaRuntimeRoot,
  type YuantaRuntimePointer,
} from '../../core/yuanta-runtime.js'
import { extractTrustedZip } from './zip-extractor.js'

export async function installYuantaRuntime(acceptVendorLicense: boolean): Promise<void> {
  if (await resolveYuantaRuntime()) return
  if (!acceptVendorLicense) throw new Error('You must accept the Yuanta SPARK API component license before downloading its runtime.')
  const release = `${YUANTA_RUNTIME_VERSION}-${YUANTA_RUNTIME_SHA256.slice(0, 16)}`
  const releaseRoot = resolve(yuantaRuntimeReleasesRoot(), release)
  const vendorRoot = resolve(releaseRoot, 'YuantaSparkAPI_CSharp')
  if (!await isValidRuntime(vendorRoot)) {
    const staging = resolve(yuantaRuntimeRoot(), `.staging-${process.pid}-${Date.now()}`)
    try {
      await mkdir(staging, { recursive: true })
      const archive = resolve(staging, 'YuantaSparkAPI_CSharp.zip')
      await downloadRuntime(archive)
      const actual = await sha256(archive)
      if (actual !== YUANTA_RUNTIME_SHA256) throw new Error(`Yuanta runtime checksum mismatch: expected ${YUANTA_RUNTIME_SHA256}, got ${actual}`)
      const payload = resolve(staging, 'payload')
      await mkdir(payload, { recursive: true })
      await extractTrustedZip(archive, payload)
      if (!await isValidRuntime(resolve(payload, 'YuantaSparkAPI_CSharp'))) throw new Error('Yuanta runtime archive is missing YuantaSparkAPI.dll')
      await mkdir(yuantaRuntimeReleasesRoot(), { recursive: true })
      try { await rename(payload, releaseRoot) } catch {
        if (!await isValidRuntime(vendorRoot)) throw new Error('Unable to activate the Yuanta runtime release')
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  const pointer: YuantaRuntimePointer = {
    schemaVersion: 1,
    version: YUANTA_RUNTIME_VERSION,
    release,
    sourceUrl: YUANTA_RUNTIME_URL,
    sha256: YUANTA_RUNTIME_SHA256,
    acceptedAt: new Date().toISOString(),
  }
  await mkdir(yuantaRuntimeRoot(), { recursive: true })
  const active = yuantaRuntimeActivePath()
  const temporary = `${active}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(pointer, null, 2) + '\n')
  await rename(temporary, active)
}

export async function resolveYuantaRuntime(): Promise<string | null> {
  try {
    const pointer = JSON.parse(await readFile(yuantaRuntimeActivePath(), 'utf8')) as YuantaRuntimePointer
    if (pointer.schemaVersion !== 1 || pointer.version !== YUANTA_RUNTIME_VERSION || !/^[A-Za-z0-9._-]+$/.test(pointer.release)) return null
    const vendorRoot = resolve(yuantaRuntimeReleasesRoot(), pointer.release, 'YuantaSparkAPI_CSharp')
    return await isValidRuntime(vendorRoot) ? vendorRoot : null
  } catch { return null }
}

async function downloadRuntime(target: string): Promise<void> {
  const response = await fetch(YUANTA_RUNTIME_URL, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok || !response.body) throw new Error(`Yuanta runtime download failed: HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared && declared !== YUANTA_RUNTIME_SIZE) throw new Error(`Yuanta runtime published size changed: expected ${YUANTA_RUNTIME_SIZE}, got ${declared}`)
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target, { flags: 'wx' }))
  const downloaded = (await stat(target)).size
  if (downloaded !== YUANTA_RUNTIME_SIZE) throw new Error(`Yuanta runtime size mismatch: expected ${YUANTA_RUNTIME_SIZE}, got ${downloaded}`)
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function isValidRuntime(root: string): Promise<boolean> {
  try { return (await stat(resolve(root, 'YuantaSparkAPI.dll'))).isFile() } catch { return false }
}
