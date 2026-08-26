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
    // Mirrors the base transport surface FutuGatewayClient attaches
    // connection-loss hooks to (base.js invokes these user hooks on
    // socket close/error).
    websock: { onclose: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null } = { onclose: null, onerror: null }
    start = vi.fn((_ip: string, _port: number, _ssl: boolean, _key: string | null) => {
      queueMicrotask(() => this.onlogin?.(true, null))
    })
    stop = vi.fn()
    Sub = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: {} }))
    UnlockTrade = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: {} }))
    PlaceOrder = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: { orderID: '900001', orderIDEx: 'ex-900001' } }))
    ModifyOrder = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: { orderID: '900001' } }))
    GetOrderList = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: { orderList: [] } }))
    GetHistoryOrderList = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: { orderList: [] } }))
    SubAccPush = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: {} }))
    RequestHistoryKL = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: { klList: [] } }))
    GetOrderFee = vi.fn(async (_req: unknown) => ({ retType: 0, s2c: { orderFeeList: [] } }))

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
    TrdUpdateOrder: { cmd: 2208, name: 'Trd_UpdateOrder', description: '订单状态变动通知(推送)' },
    TrdUpdateOrderFill: { cmd: 2218, name: 'Trd_UpdateOrderFill', description: '成交通知(推送)' },
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

  it('requestHistoryKL sends one Qot_RequestHistoryKL page and passes the cursor through', async () => {
    const row = { time: '2024-06-03 00:00:00', isBlank: false, openPrice: 1, highPrice: 2, lowPrice: 0.5, closePrice: 1.5, volume: 10, timestamp: 1_717_372_800 }
    const { client, ws } = await connectedClient()
    ws.RequestHistoryKL.mockResolvedValueOnce({ retType: 0, s2c: { klList: [row], nextReqKey: 'cursor-9' } })

    const page = await client.requestHistoryKL({
      security: SEC_700, rehabType: 1, klType: 2,
      beginTime: '2024-05-01 00:00:00', endTime: '2024-06-04 00:00:00', maxAckKLNum: 1000,
    })

    expect(page).toEqual({ klList: [row], nextReqKey: 'cursor-9' })
    expect(ws.RequestHistoryKL).toHaveBeenCalledWith({
      c2s: {
        rehabType: 1, klType: 2, security: SEC_700,
        beginTime: '2024-05-01 00:00:00', endTime: '2024-06-04 00:00:00', maxAckKLNum: 1000,
      },
    })
    // Final page: no cursor key at all rather than an explicit undefined.
    expect(await client.requestHistoryKL({ security: SEC_700, rehabType: 1, klType: 2, beginTime: 'a', endTime: 'b' })).toEqual({ klList: [] })
  })

  it('getHistoryOrderList sends the required time window and optional idList', async () => {
    const row = { trdSide: 1, orderType: 1, orderStatus: 5, orderID: '900001', orderIDEx: 'ex', code: '00700', name: 'Tencent', qty: 100, createTime: '', updateTime: '' }
    const { client, ws } = await connectedClient()
    ws.GetHistoryOrderList.mockResolvedValueOnce({ retType: 0, s2c: { orderList: [row] } })
    const rows = await client.getHistoryOrderList(HEADER, {
      beginTime: '2024-01-01 00:00:00',
      endTime: '2024-02-01 00:00:00',
      idList: ['900001'],
    })
    expect(rows).toEqual([row])
    expect(ws.GetHistoryOrderList).toHaveBeenCalledWith({
      c2s: {
        header: HEADER,
        filterConditions: { beginTime: '2024-01-01 00:00:00', endTime: '2024-02-01 00:00:00', idList: ['900001'] },
      },
    })
  })

  it('subscribeOrderUpdates registers via Trd_SubAccPush and delivers Trd_UpdateOrder pushes', async () => {
    const { client, ws } = await connectedClient()
    const pushed: unknown[] = []
    await client.subscribeOrderUpdates('11111', (order) => pushed.push(order))
    expect(ws.SubAccPush).toHaveBeenCalledWith({ c2s: { accIDList: ['11111'] } })

    const order = { trdSide: 1, orderType: 1, orderStatus: 11, orderID: '900001', orderIDEx: 'ex', code: '00700', name: 'Tencent', qty: 100, createTime: '', updateTime: '' }
    ws.onPush?.(2208, { s2c: { order } })
    expect(pushed).toEqual([order])

    // Unrelated commands and empty payloads are ignored.
    ws.onPush?.(2208, { s2c: {} })
    ws.onPush?.(9999, { s2c: { order } })
    expect(pushed).toHaveLength(1)
  })

  it('drops the push registration when the SubAccPush wire call fails', async () => {
    const { client, ws } = await connectedClient()
    ws.SubAccPush.mockRejectedValueOnce(new Error('not ready'))
    await expect(client.subscribeOrderUpdates('11111', () => {})).rejects.toThrow('not ready')

    const order = { trdSide: 1, orderType: 1, orderStatus: 11, orderID: '1', orderIDEx: '', code: '00700', name: '', qty: 1, createTime: '', updateTime: '' }
    // A push arriving after the failed registration must not reach the callback.
    expect(() => ws.onPush?.(2208, { s2c: { order } })).not.toThrow()
  })

  it('delivers Trd_UpdateOrderFill pushes to the fill callback', async () => {
    const { client, ws } = await connectedClient()
    const fills: unknown[] = []
    await client.subscribeOrderUpdates('11111', () => {}, (fill) => fills.push(fill))

    const orderFill = { trdSide: 1, fillID: '5001', orderID: '900001', orderIDEx: 'ex-900001', code: '00700', qty: 100, price: 320.4, createTime: '2024-06-03 10:00:00' }
    ws.onPush?.(2218, { s2c: { orderFill } })
    expect(fills).toEqual([orderFill])

    // No fill callback registered → fill pushes are silently ignored.
    await client.subscribeOrderUpdates('11111', () => {})
    expect(() => ws.onPush?.(2218, { s2c: { orderFill } })).not.toThrow()
    expect(fills).toHaveLength(1)
  })

  it('getOrderFee sends orderIdExList and returns fee rows', async () => {
    const feeRow = { orderIDEx: 'ex-900001', feeAmount: 15.5, feeList: [{ title: '佣金', value: 15.5 }] }
    const { client, ws } = await connectedClient()
    ws.GetOrderFee.mockResolvedValueOnce({ retType: 0, s2c: { orderFeeList: [feeRow] } })

    const fees = await client.getOrderFee(HEADER, ['ex-900001'])

    expect(fees).toEqual([feeRow])
    expect(ws.GetOrderFee).toHaveBeenCalledWith({ c2s: { header: HEADER, orderIdExList: ['ex-900001'] } })
  })

  it('getOrderFee short-circuits an empty id list without a wire call', async () => {
    const { client, ws } = await connectedClient()
    expect(await client.getOrderFee(HEADER, [])).toEqual([])
    expect(ws.GetOrderFee).not.toHaveBeenCalled()
  })
})

describe('FutuGatewayClient connection state', () => {
  it('reports dead when the transport closes unexpectedly', async () => {
    const { client, ws } = await connectedClient()
    const events: unknown[] = []
    client.setConnectionListener((e) => events.push(e))

    ws.websock.onclose?.({ code: 1006 })

    expect(events).toEqual([
      expect.objectContaining({ state: 'dead', error: expect.stringMatching(/closed unexpectedly/i) }),
    ])
  })

  it('suppresses dead events for a deliberate stop()', async () => {
    const { client, ws } = await connectedClient()
    const events: unknown[] = []
    client.setConnectionListener((e) => events.push(e))

    client.stop()
    ws.websock.onclose?.({ code: 1000 })

    expect(events).toEqual([])
  })

  it('re-subscribes quotes and order push after an SDK auto-reconnect, then reports restored', async () => {
    const { client, ws } = await connectedClient()
    const events: unknown[] = []
    client.setConnectionListener((e) => events.push(e))
    await client.subscribeBasicQuote([SEC_700, SEC_AAPL], () => {})
    await client.subscribeOrderUpdates('11111', () => {})
    ws.Sub.mockClear()
    ws.SubAccPush.mockClear()

    // base.js auto-reconnects a dropped socket and re-fires onlogin(true).
    ws.onlogin?.(true, null)
    await vi.waitFor(() => expect(events).toContainEqual({ state: 'restored' }))

    expect(ws.Sub).toHaveBeenCalledWith({
      c2s: { securityList: [SEC_700, SEC_AAPL], subTypeList: [1], isSubOrUnSub: true, isRegOrUnRegPush: true },
    })
    expect(ws.SubAccPush).toHaveBeenCalledWith({ c2s: { accIDList: ['11111'] } })
  })

  it('reports dead when the post-reconnect re-subscribe itself fails', async () => {
    const { client, ws } = await connectedClient()
    const events: unknown[] = []
    client.setConnectionListener((e) => events.push(e))
    await client.subscribeBasicQuote([SEC_700], () => {})
    ws.Sub.mockRejectedValueOnce(new Error('socket dropped again'))

    ws.onlogin?.(true, null)
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ state: 'dead', error: expect.stringMatching(/socket dropped again/) }),
      ),
    )
  })
})
