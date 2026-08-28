import { resolve } from 'node:path'
import { runtimePath } from './paths.js'

export const YUANTA_RUNTIME_VERSION = '2026.7.13.10859'
export const YUANTA_RUNTIME_URL = 'https://ys.yuanta.com.tw/quartet/api/YuantaSparkAPI_CSharp.zip'
export const YUANTA_RUNTIME_SIZE = 61_396_858
export const YUANTA_RUNTIME_SHA256 = 'bbebaf004893b1c61bbd686029d35e78a6d48e8e316a3d4e0e65e3c5ef8f57ca'

export interface YuantaRuntimePointer {
  schemaVersion: 1
  version: string
  release: string
  sourceUrl: string
  sha256: string
  acceptedAt: string
}

export function yuantaRuntimeRoot(): string { return runtimePath('vendor', 'yuanta-spark') }
export function yuantaRuntimeActivePath(): string { return resolve(yuantaRuntimeRoot(), 'active.json') }
export function yuantaRuntimeReleasesRoot(): string { return resolve(yuantaRuntimeRoot(), 'releases') }
