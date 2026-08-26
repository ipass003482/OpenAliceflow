import { describe, it, expect, vi } from 'vitest'
import { FutuGatewayClient } from './FutuGatewayClient.js'

// ==================== futu-api SDK mock ====================
//
// Mirrors the real ftWebsocket surface FutuGatewayClient actually drives:
// onlogin/onPush callback slots, start()/stop(), and one Sub() call per
// (un)subscribe. No real or simulated network socket — start() resolves the
// login handshake on a microtask, matching the async nature of the real SDK
// without needing a fake timer.
//
// vi.mock's factory is hoisted above this file's imports, so FakeWs and the
// lastInstance tracker must live inside vi.hoisted rather than as ordinary
// top-level bindings the factory closes over.
const { FakeWs, getLastInstance } = vi.hoisted(() => {
  let lastInstance: InstanceType<typeof FakeWsImpl> | null = null
  class FakeWsImpl {
    onlogin: ((ret: boolean, msg?: unknown) => void) | null = null
    onPush: ((cmd: number, response: unknown) => void) | null = null
    start = vi.fn((_ip: string, _port: number, _ssl: boolean, _key: string | null) => {
      queueMicrotask(() => this.onlogin?.(true, null))
    })
    stop = vi.fn()
    Sub = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: {} }))

    constructor() {
      lastInstance = this
    }
  }
  return { FakeWs: FakeWsImpl, getLastInstance: () => lastInstance }
})

vi.mock('futu-api', () => ({
  default: FakeWs,
  ftCmdID: {
    QotUpdateBasicQot: { cmd: 3005, name: 'Qot_UpdateBasicQot', description: '推送基本行情' },
  },
}))

async function connectedClient(): Promise<{ client: FutuGatewayClient; ws: InstanceType<typeof FakeWs> }> {
  const client = new FutuGatewayClient({ host: '127.0.0.1', port: 33333, ssl: false })
  await client.connect()
  return { client, ws: getLastInstance()! }
}

const SEC_700 = { market: 1, code: '00700' }
const SEC_AAPL = { market: 11, code: 'AAPL' }

function pushBasicQot(ws: FakeWs, rows: Array<{ security: { market: number; code: string } }>): void {
  ws.onPush?.(3005, { s2c: { basicQotList: rows } })
}

describe('FutuGatewayClient.subscribeBasicQuote', () => {
  it('subscribes with SubType_Basic and registers push', async () => {
    const { client, ws } = await connectedClient()
    await client.subscribeBasicQuote([SEC_700], () => {})
    expect(ws.Sub).toHaveBeenCalledWith({
      c2s: { securityList: [SEC_700], subTypeList: [1], isSubOrUnSub: true, isRegOrUnRegPush: true },
    })
  })

  it('delivers a push only to the matching subscription', async () => {
    const { client, ws } = await connectedClient()
    const a: unknown[] = []
    const b: unknown[] = []
    await client.subscribeBasicQuote([SEC_700], (rows) => a.push(...rows))
    await client.subscribeBasicQuote([SEC_AAPL], (rows) => b.push(...rows))

    pushBasicQot(ws, [{ security: SEC_700 }])

    expect(a).toEqual([{ security: SEC_700 }])
    expect(b).toEqual([])
  })

  it('fans one push out to two overlapping subscriptions on the same security', async () => {
    const { client, ws } = await connectedClient()
    const a: unknown[] = []
    const b: unknown[] = []
    await client.subscribeBasicQuote([SEC_700], (rows) => a.push(...rows))
    await client.subscribeBasicQuote([SEC_700], (rows) => b.push(...rows))

    pushBasicQot(ws, [{ security: SEC_700 }])

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('ignores pushes for other commands and empty batches', async () => {
    const { client, ws } = await connectedClient()
    const a: unknown[] = []
    await client.subscribeBasicQuote([SEC_700], (rows) => a.push(...rows))

    ws.onPush?.(9999, { s2c: { basicQotList: [{ security: SEC_700 }] } })
    ws.onPush?.(3005, { s2c: { basicQotList: [] } })
    ws.onPush?.(3005, {})

    expect(a).toEqual([])
  })

  it('only un-subscribes on the wire once no remaining subscription wants that security', async () => {
    const { client, ws } = await connectedClient()
    const unsubA = await client.subscribeBasicQuote([SEC_700], () => {})
    const unsubB = await client.subscribeBasicQuote([SEC_700], () => {})
    ws.Sub.mockClear()

    await unsubA()
    // Another subscription (B) still wants SEC_700 — no wire unsubscribe yet.
    expect(ws.Sub).not.toHaveBeenCalled()

    await unsubB()
    // Now nothing wants it — the wire unsubscribe fires.
    expect(ws.Sub).toHaveBeenCalledWith({
      c2s: { securityList: [SEC_700], subTypeList: [1], isSubOrUnSub: false, isRegOrUnRegPush: false },
    })
  })

  it('stops delivering to a subscription after it unsubscribes', async () => {
    const { client, ws } = await connectedClient()
    const a: unknown[] = []
    const unsub = await client.subscribeBasicQuote([SEC_700], (rows) => a.push(...rows))
    await unsub()

    pushBasicQot(ws, [{ security: SEC_700 }])

    expect(a).toEqual([])
  })

  it('swallows a failed wire unsubscribe instead of throwing', async () => {
    const { client, ws } = await connectedClient()
    const unsub = await client.subscribeBasicQuote([SEC_700], () => {})
    ws.Sub.mockImplementationOnce(async () => { throw new Error('connection closing') })
    await expect(unsub()).resolves.toBeUndefined()
  })

  it('clears all subscriptions on stop()', async () => {
    const { client, ws } = await connectedClient()
    const a: unknown[] = []
    await client.subscribeBasicQuote([SEC_700], (rows) => a.push(...rows))
    client.stop()

    // A late push arriving after stop() must not reach a cleared subscription
    // (defensive — stop() already nulls `this.ws`, this exercises the map).
    pushBasicQot(ws, [{ security: SEC_700 }])
    expect(a).toEqual([])
  })
})
