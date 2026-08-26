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
    UnlockTrade = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: {} }))
    PlaceOrder = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: { orderID: '900001', orderIDEx: 'ex-900001' } }))
    ModifyOrder = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: { orderID: '900001' } }))
    GetOrderList = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: { orderList: [] } }))

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

function pushBasicQot(ws: InstanceType<typeof FakeWs>, rows: Array<{ security: { market: number; code: string } }>): void {
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

const HEADER = { trdEnv: 0, accID: '11111', trdMarket: 1 }

describe('FutuGatewayClient trading writes', () => {
  it('unlockTrade sends Trd_UnlockTrade with the given pwdMD5', async () => {
    const { client, ws } = await connectedClient()
    await client.unlockTrade('deadbeef')
    expect(ws.UnlockTrade).toHaveBeenCalledWith({ c2s: { unlock: true, pwdMD5: 'deadbeef' } })
  })

  it('placeOrder sends Trd_PlaceOrder and resolves the assigned order id', async () => {
    const { client, ws } = await connectedClient()
    const result = await client.placeOrder({ header: HEADER, trdSide: 1, orderType: 2, code: '00700', qty: 100 })
    expect(result).toEqual({ orderID: '900001', orderIDEx: 'ex-900001' })
    expect(ws.PlaceOrder).toHaveBeenCalledWith({
      c2s: { header: HEADER, trdSide: 1, orderType: 2, code: '00700', qty: 100, price: undefined, auxPrice: undefined, timeInForce: undefined },
    })
  })

  it('modifyOrder sends Trd_ModifyOrder for both price/qty changes and cancel', async () => {
    const { client, ws } = await connectedClient()
    const result = await client.modifyOrder({ header: HEADER, orderID: '900001', modifyOrderOp: 2 })
    expect(result).toEqual({ orderID: '900001' })
    expect(ws.ModifyOrder).toHaveBeenCalledWith({
      c2s: { header: HEADER, orderID: '900001', modifyOrderOp: 2, qty: undefined, price: undefined, auxPrice: undefined },
    })
  })

  it('getOrderList sends Trd_GetOrderList and returns the order rows', async () => {
    const row = { trdSide: 1, orderType: 1, orderStatus: 5, orderID: '900001', orderIDEx: 'ex', code: '00700', name: 'Tencent', qty: 100, createTime: '', updateTime: '' }
    const { client, ws } = await connectedClient()
    ws.GetOrderList.mockResolvedValueOnce({ retType: 0, s2c: { orderList: [row] } })
    const rows = await client.getOrderList(HEADER)
    expect(rows).toEqual([row])
    expect(ws.GetOrderList).toHaveBeenCalledWith({ c2s: { header: HEADER } })
  })

  it('getOrderList defaults to an empty array when orderList is absent', async () => {
    const { client } = await connectedClient()
    expect(await client.getOrderList(HEADER)).toEqual([])
  })
})
