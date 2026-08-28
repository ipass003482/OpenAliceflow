import { inflateRawSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

export async function extractTrustedZip(archive: string, destination: string): Promise<void> {
  const zip = await readFile(archive)
  const eocd = findEocd(zip)
  const entries = zip.readUInt16LE(eocd + 10)
  const centralOffset = zip.readUInt32LE(eocd + 16)
  if (entries > 20_000) throw new Error('Vendor archive contains too many files')
  let cursor = centralOffset
  let expanded = 0
  for (let index = 0; index < entries; index++) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('Invalid ZIP central directory')
    const method = zip.readUInt16LE(cursor + 10)
    const compressedSize = zip.readUInt32LE(cursor + 20)
    const uncompressedSize = zip.readUInt32LE(cursor + 24)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const localOffset = zip.readUInt32LE(cursor + 42)
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replace(/\\/g, '/')
    cursor += 46 + nameLength + extraLength + commentLength
    if (!name || name.startsWith('/') || name.includes('../') || /^[A-Za-z]:/.test(name)) throw new Error(`Unsafe ZIP entry: ${name}`)
    const target = resolve(destination, ...name.split('/').filter(Boolean))
    if (target !== destination && !target.startsWith(`${destination}${sep}`)) throw new Error(`ZIP entry escapes destination: ${name}`)
    if (name.endsWith('/')) { await mkdir(target, { recursive: true }); continue }
    expanded += uncompressedSize
    if (expanded > 768 * 1024 * 1024) throw new Error('Vendor archive expands beyond the safety limit')
    if (zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error(`Invalid ZIP local entry: ${name}`)
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const compressed = zip.subarray(start, start + compressedSize)
    const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null
    if (!content) throw new Error(`Unsupported ZIP compression method ${method}`)
    if (content.length !== uncompressedSize) throw new Error(`ZIP size mismatch for ${name}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, { flag: 'wx' })
  }
}

function findEocd(zip: Buffer): number {
  const floor = Math.max(0, zip.length - 65_557)
  for (let offset = zip.length - 22; offset >= floor; offset--) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error('ZIP end-of-central-directory record was not found')
}
