import { describe, it, expect, vi } from 'vitest'
import Decimal from 'decimal.js'
import { createHash } from 'node:crypto'
import { Contract, Order } from '@traderalice/ibkr'
import { FutuBroker } from './FutuBroker.js'
import { makeContract, parseFutuKey, resolveFutuKey, securityToKey, keyToSecurity, trdSecMarketToPrefix } from './futu-contracts.js'
import type { FutuGateway, FutuGlobalStateLike } from './futu-types.js'
import '../../contract-ext.js'

// ==================== Fake gateway ====================

const OPEN_GLOBAL_STATE: FutuGlobalStateLike = {
  marketHK: 3, marketUS: 6, marketSH: 6, marketSZ: 6, qotLogined: true, trdLogined: true, serverVer: 900, time: 1_750_000_000,
}

function makeGateway(overrides: Partial<FutuGateway> = {}): FutuGateway {
  return {
    connect: vi.fn(async () => {}),
    stop: vi.fn(),
    getGlobalState: vi.fn(async () => OPEN_GLOBAL_STATE),
    getAccList: vi.fn(async () => [
      { trdEnv: 0, accID: '11111', trdMarketAuthList: [1, 2], simAccType: 1 },
      { trdEnv: 1, accID: '22222', trdMarketAuthList: [1, 2] },
    ]),
    getFunds: vi.fn(async () => null),
    getPositionList: vi.fn(async () => []),
    getSecuritySnapshot: vi.fn(async () => []),
    getStaticInfo: vi.fn(async () => []),
    subscribeBasicQuote: vi.fn(async () => vi.fn(async () => {})),
    unlockTrade: vi.fn(async () => {}),
    placeOrder: vi.fn(async () => ({ orderID: '900000001' })),
    modifyOrder: vi.fn(async () => ({ orderID: '900000001' })),
    getOrderList: vi.fn(async () => []),
    getHistoryOrderList: vi.fn(async () => []),
    requestHistoryKL: vi.fn(async () => ({ klList: [] })),
    getOrderFee: vi.fn(async () => []),
    subscribeOrderUpdates: vi.fn(async () => {}),
    setConnectionListener: vi.fn(),
    ...overrides,
  }
}

function makeBroker(gateway: FutuGateway, cfg: Partial<{ trdEnv: 'simulate' | 'real'; trdMarket: 'HK' | 'US' | 'CN' | 'SG' | 'JP'; accID: string }> = {}): FutuBroker {
  const parsed = FutuBroker.configSchema.parse({ trdEnv: cfg.trdEnv ?? 'simulate', trdMarket: cfg.trdMarket ?? 'HK', ...(cfg.accID ? { accID: cfg.accID } : {}) })
  return new FutuBroker({ ...parsed, id: 'futu-test' }, () => gateway)
}

// ==================== Key parsing & contract resolution ====================

describe('parseFutuKey', () => {
  it('parses HK-prefixed keys', () => {
    expect(parseFutuKey('HK.00700')).toEqual({ prefix: 'HK', code: '00700' })
  })

  it('parses US-prefixed keys', () => {
    expect(parseFutuKey('US.AAPL')).toEqual({ prefix: 'US', code: 'AAPL' })
  })

  it('defaults bare codes to US', () => {
    expect(parseFutuKey('AAPL')).toEqual({ prefix: 'US', code: 'AAPL' })
  })

  it('treats an unknown prefix as a bare US code', () => {
    expect(parseFutuKey('XX.FOO')).toEqual({ prefix: 'US', code: 'XX.FOO' })
  })
})

describe('makeContract', () => {
  it('maps HK keys to SEHK/HKD', () => {
    const c = makeContract('HK.00700')
    expect(c.symbol).toBe('00700')
    expect(c.localSymbol).toBe('HK.00700')
    expect(c.secType).toBe('STK')
    expect(c.exchange).toBe('SEHK')
    expect(c.currency).toBe('HKD')
  })

  it('maps SH keys to SSE/CNH', () => {
    const c = makeContract('SH.600519')
    expect(c.exchange).toBe('SSE')
    expect(c.currency).toBe('CNH')
  })
})

describe('resolveFutuKey', () => {
  it('round-trips via localSymbol', () => {
    expect(resolveFutuKey(makeContract('HK.00700'))).toBe('HK.00700')
  })

  it('falls back to the aliceId native key', () => {
    const c = new Contract()
    c.symbol = '00700'
    c.aliceId = 'futu-test|HK.00700'
    expect(resolveFutuKey(c)).toBe('HK.00700')
  })

  it('infers the prefix from currency as a last resort', () => {
    const c = new Contract()
    c.symbol = '00700'
    c.currency = 'HKD'
    expect(resolveFutuKey(c)).toBe('HK.00700')
  })

  it('returns null when nothing is resolvable', () => {
    expect(resolveFutuKey(new Contract())).toBeNull()
  })
})

describe('security/key round-trip', () => {
  it('maps wire security to key and back', () => {
    expect(securityToKey({ market: 1, code: '00700' })).toBe('HK.00700')
    expect(keyToSecurity('HK.00700')).toEqual({ market: 1, code: '00700' })
    expect(keyToSecurity('US.AAPL')).toEqual({ market: 11, code: 'AAPL' })
  })

  it('maps TrdSecMarket enum values to prefixes', () => {
    expect(trdSecMarketToPrefix(1)).toBe('HK')
    expect(trdSecMarketToPrefix(31)).toBe('SH')
    expect(trdSecMarketToPrefix(32)).toBe('SZ')
    expect(trdSecMarketToPrefix(undefined)).toBe('US')
  })
})

// ==================== init / account selection ====================

describe('FutuBroker.init', () => {
  it('picks the first simulate account with the requested market auth', async () => {
    const gateway = makeGateway()
    const broker = makeBroker(gateway)
    await broker.init()
    await broker.getAccount()
    expect(gateway.getFunds).toHaveBeenCalledWith({ trdEnv: 0, accID: '11111', trdMarket: 1 })
  })

  it('honors an explicit accID', async () => {
    const gateway = makeGateway({
      getAccList: vi.fn(async () => [
        { trdEnv: 0, accID: '11111', trdMarketAuthList: [1], simAccType: 1 },
        { trdEnv: 0, accID: '33333', trdMarketAuthList: [1], simAccType: 1 },
      ]),
    })
    const broker = makeBroker(gateway, { accID: '33333' })
    await broker.init()
    await broker.getAccount()
    expect(gateway.getFunds).toHaveBeenCalledWith(expect.objectContaining({ accID: '33333' }))
  })

  it('refuses with CONFIG when no account matches env and market', async () => {
    const gateway = makeGateway({ getAccList: vi.fn(async () => [{ trdEnv: 1, accID: '22222', trdMarketAuthList: [2] }]) })
    const broker = makeBroker(gateway)
    await expect(broker.init()).rejects.toMatchObject({ name: 'BrokerError', code: 'CONFIG' })
  })

  it('ignores option-only paper accounts when selecting an equity account', async () => {
    const gateway = makeGateway({
      getAccList: vi.fn(async () => [
        { trdEnv: 0, accID: 'option-only', trdMarketAuthList: [1], simAccType: 2 },
        { trdEnv: 0, accID: 'stock', trdMarketAuthList: [1], simAccType: 1 },
      ]),
    })
    const broker = makeBroker(gateway)
    await broker.init()
    await broker.getAccount()
    expect(gateway.getFunds).toHaveBeenCalledWith(expect.objectContaining({ accID: 'stock' }))
  })

  it('requires accID when multiple stock paper accounts match', async () => {
    const gateway = makeGateway({
      getAccList: vi.fn(async () => [
        { trdEnv: 0, accID: 'stock-cash', trdMarketAuthList: [1], simAccType: 1 },
        { trdEnv: 0, accID: 'stock-margin', trdMarketAuthList: [1], simAccType: 4 },
      ]),
    })
    const broker = makeBroker(gateway)
    await expect(broker.init()).rejects.toMatchObject({ name: 'BrokerError', code: 'CONFIG' })
    await expect(broker.init()).rejects.toThrow(/set accID explicitly/)
  })

  it('refuses with AUTH when FutuOpenD is not trade-logged-in', async () => {
    const gateway = makeGateway({ getGlobalState: vi.fn(async () => ({ ...OPEN_GLOBAL_STATE, trdLogined: false })) })
    const broker = makeBroker(gateway)
    await expect(broker.init()).rejects.toMatchObject({ name: 'BrokerError', code: 'AUTH' })
  })

  it('wraps connect failures as NETWORK', async () => {
    const gateway = makeGateway({ connect: vi.fn(async () => { throw new Error('ECONNREFUSED 127.0.0.1:33333') }) })
    const broker = makeBroker(gateway)
    await expect(broker.init()).rejects.toMatchObject({ name: 'BrokerError', code: 'NETWORK' })
  })
})

// ==================== getAccount ====================

describe('FutuBroker.getAccount', () => {
  it('maps Funds onto AccountInfo', async () => {
    const gateway = makeGateway({
      getFunds: vi.fn(async () => ({
        power: 200000.5, totalAssets: 1000000.123, cash: 500000, marketVal: 500000, frozenCash: 0, debtCash: 0, avlWithdrawalCash: 400000,
        currency: 1, unrealizedPL: 1234.5, realizedPL: -56.7, initialMargin: 1000, maintenanceMargin: 800,
      })),
    })
    const broker = makeBroker(gateway)
    await broker.init()
    const info = await broker.getAccount()
    expect(info).toEqual({
      baseCurrency: 'HKD',
      netLiquidation: '1000000.123',
      totalCashValue: '500000',
      unrealizedPnL: '1234.5',
      buyingPower: '200000.5',
      realizedPnL: '-56.7',
      initMarginReq: '1000',
      maintMarginReq: '800',
    })
  })

  it('falls back to the market currency and zeros when funds are absent', async () => {
    const broker = makeBroker(makeGateway(), { trdMarket: 'US' })
    await broker.init()
    const info = await broker.getAccount()
    expect(info).toEqual({ baseCurrency: 'USD', netLiquidation: '0', totalCashValue: '0', unrealizedPnL: '0' })
  })
})

// ==================== getPositions ====================

describe('FutuBroker.getPositions', () => {
  it('maps a securities position with broker-computed values', async () => {
    const gateway = makeGateway({
      getPositionList: vi.fn(async () => [{
        positionID: '1', positionSide: 0, code: '00700', name: 'Tencent', qty: 100, canSellQty: 100,
        price: 620.5, val: 62050, plVal: 1050, secMarket: 1, currency: 1, averageCostPrice: 610,
      }]),
    })
    const broker = makeBroker(gateway)
    await broker.init()
    const positions = await broker.getPositions()
    expect(positions).toHaveLength(1)
    const p = positions[0]
    expect(p.contract.localSymbol).toBe('HK.00700')
    expect(p.contract.description).toBe('Tencent')
    expect(p.side).toBe('long')
    expect(p.quantity.eq(new Decimal(100))).toBe(true)
    expect(p.avgCost).toBe('610')
    expect(p.marketPrice).toBe('620.5')
    expect(p.marketValue).toBe('62050')
    expect(p.unrealizedPnL).toBe('1050')
    expect(p.currency).toBe('HKD')
    expect(p.multiplier).toBe('1')
  })

  it('skips zero-quantity rows and derives math when val is 0', async () => {
    const gateway = makeGateway({
      getPositionList: vi.fn(async () => [
        { positionID: '1', positionSide: 0, code: 'AAPL', name: 'Apple', qty: 0, canSellQty: 0, price: 200, val: 0, plVal: 0, secMarket: 2 },
        { positionID: '2', positionSide: 1, code: 'TSLA', name: 'Tesla', qty: 10, canSellQty: 10, price: 250, val: 0, plVal: 0, secMarket: 2, costPrice: 300 },
      ]),
    })
    const broker = makeBroker(gateway, { trdMarket: 'US' })
    await broker.init()
    const positions = await broker.getPositions()
    expect(positions).toHaveLength(1)
    const p = positions[0]
    expect(p.side).toBe('short')
    expect(p.currency).toBe('USD')
    // Short 10 @ cost 300, now 250 → derived unrealized +500.
    expect(new Decimal(p.unrealizedPnL).eq(500)).toBe(true)
  })
})

// ==================== getQuote / getMarketClock ====================

describe('FutuBroker.getQuote', () => {
  it('maps a snapshot onto Quote', async () => {
    const gateway = makeGateway({
      getSecuritySnapshot: vi.fn(async () => [{
        basic: {
          security: { market: 1, code: '00700' }, type: 3, isSuspend: false, lotSize: 100, updateTime: '2026-08-26 10:00:00',
          highPrice: 630, openPrice: 615, lowPrice: 612, lastClosePrice: 618, curPrice: 620.5, volume: '1234567', turnover: 7.6e8,
          updateTimestamp: 1_750_000_000, askPrice: 620.6, bidPrice: 620.4,
        },
      }]),
    })
    const broker = makeBroker(gateway)
    await broker.init()
    const quote = await broker.getQuote(makeContract('HK.00700'))
    expect(quote.last).toBe('620.5')
    expect(quote.bid).toBe('620.4')
    expect(quote.ask).toBe('620.6')
    expect(quote.volume).toBe('1234567')
    expect(quote.high).toBe('630')
    expect(quote.low).toBe('612')
    expect(quote.timestamp).toEqual(new Date(1_750_000_000 * 1000))
  })

  it('defaults missing bid/ask to 0 and refuses empty snapshots', async () => {
    const gateway = makeGateway({
      getSecuritySnapshot: vi.fn(async () => [{
        basic: {
          security: { market: 11, code: 'AAPL' }, type: 3, isSuspend: false, lotSize: 1, updateTime: '',
          highPrice: 1, openPrice: 1, lowPrice: 1, lastClosePrice: 1, curPrice: 1, volume: 0, turnover: 0,
        },
      }]),
    })
    const broker = makeBroker(gateway, { trdMarket: 'US' })
    await broker.init()
    const quote = await broker.getQuote(makeContract('US.AAPL'))
    expect(quote.bid).toBe('0')
    expect(quote.ask).toBe('0')

    const empty = makeGateway({ getSecuritySnapshot: vi.fn(async () => []) })
    const broker2 = makeBroker(empty, { trdMarket: 'US' })
    await broker2.init()
    await expect(broker2.getQuote(makeContract('US.AAPL'))).rejects.toMatchObject({ name: 'BrokerError' })
  })
})

describe('FutuBroker.getMarketClock', () => {
  it('reports open during the HK morning session and closed after close', async () => {
    const broker = makeBroker(makeGateway())
    await broker.init()
    expect((await broker.getMarketClock()).isOpen).toBe(true)

    const closed = makeBroker(makeGateway({ getGlobalState: vi.fn(async () => ({ ...OPEN_GLOBAL_STATE, marketHK: 6 })) }))
    await closed.init()
    expect((await closed.getMarketClock()).isOpen).toBe(false)
  })
})

// ==================== getContractDetails ====================

describe('FutuBroker.getContractDetails', () => {
  it('fills details from static info', async () => {
    const gateway = makeGateway({
      getStaticInfo: vi.fn(async () => [{
        basic: { security: { market: 1, code: '00700' }, id: '1', lotSize: 100, secType: 3, name: 'Tencent', listTime: '2004-06-16' },
      }]),
    })
    const broker = makeBroker(gateway)
    await broker.init()
    const details = await broker.getContractDetails(makeContract('HK.00700'))
    expect(details).not.toBeNull()
    expect(details!.contract.description).toBe('Tencent')
    expect(details!.minSize.eq(new Decimal(100))).toBe(true)
  })

  it('returns null for unknown instruments', async () => {
    const broker = makeBroker(makeGateway())
    await broker.init()
    expect(await broker.getContractDetails(makeContract('HK.99999'))).toBeNull()
  })
})

// ==================== Trading operations (Increment 2) ====================

describe('FutuBroker.placeOrder', () => {
  it('places a market order and resolves the broker-assigned order id', async () => {
    const gateway = makeGateway({ placeOrder: vi.fn(async () => ({ orderID: '77001' })) })
    const broker = makeBroker(gateway)
    await broker.init()
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(100)
    const result = await broker.placeOrder(makeContract('HK.00700'), order)
    expect(result).toEqual({ success: true, orderId: '77001' })
    expect(gateway.placeOrder).toHaveBeenCalledWith({
      header: { trdEnv: 0, accID: '11111', trdMarket: 1 },
      trdSide: 1, // TrdSide_Buy
      orderType: 2, // OrderType_Market
      code: '00700',
      qty: 100,
      price: undefined,
      auxPrice: undefined,
    })
  })

  it('places a limit order with the limit price', async () => {
    const gateway = makeGateway({ placeOrder: vi.fn(async () => ({ orderID: '77002' })) })
    const broker = makeBroker(gateway)
    await broker.init()
    const order = new Order()
    order.action = 'SELL'
    order.orderType = 'LMT'
    order.totalQuantity = new Decimal(10)
    order.lmtPrice = new Decimal('123.45')
    const result = await broker.placeOrder(makeContract('US.AAPL'), order)
    expect(result.success).toBe(true)
    expect(gateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      trdSide: 2, // TrdSide_Sell
      orderType: 1, // OrderType_Normal
      price: 123.45,
    }))
  })

  it('rejects a limit order missing its limit price without touching the gateway', async () => {
    const gateway = makeGateway()
    const broker = makeBroker(gateway)
    await broker.init()
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'LMT'
    order.totalQuantity = new Decimal(1)
    const result = await broker.placeOrder(makeContract('US.AAPL'), order)
    expect(result).toEqual({ success: false, error: expect.stringMatching(/limit price/i) })
    expect(gateway.placeOrder).not.toHaveBeenCalled()
  })

  it('rejects a stop order missing its trigger price', async () => {
    const broker = makeBroker(makeGateway())
    await broker.init()
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'STP'
    order.totalQuantity = new Decimal(1)
    const result = await broker.placeOrder(makeContract('US.AAPL'), order)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/trigger|aux/i)
  })

  it('rejects an unsupported order type', async () => {
    const broker = makeBroker(makeGateway())
    await broker.init()
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'TRAIL'
    order.totalQuantity = new Decimal(1)
    const result = await broker.placeOrder(makeContract('US.AAPL'), order)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unsupported order type/i)
  })

  it('rejects bracket take-profit/stop-loss requests rather than silently dropping them', async () => {
    const gateway = makeGateway()
    const broker = makeBroker(gateway)
    await broker.init()
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(1)
    const result = await broker.placeOrder(makeContract('US.AAPL'), order, { takeProfit: { price: '200' } })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/bracket/i)
    expect(gateway.placeOrder).not.toHaveBeenCalled()
  })

  it('surfaces a gateway rejection as a failed result rather than throwing', async () => {
    const gateway = makeGateway({ placeOrder: vi.fn(async () => { throw new Error('FutuOpenD PlaceOrder retType=-1: trade not unlocked') }) })
    const broker = makeBroker(gateway)
    await broker.init()
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(1)
    const result = await broker.placeOrder(makeContract('US.AAPL'), order)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/trade not unlocked/i)
  })
})

describe('FutuBroker.modifyOrder / cancelOrder', () => {
  it('modifies price and quantity via ModifyOrderOp_Normal', async () => {
    const gateway = makeGateway({ modifyOrder: vi.fn(async () => ({ orderID: '77001' })) })
    const broker = makeBroker(gateway)
    await broker.init()
    const result = await broker.modifyOrder('77001', { totalQuantity: new Decimal(50), lmtPrice: new Decimal('10.5') })
    expect(result).toEqual({ success: true, orderId: '77001' })
    expect(gateway.modifyOrder).toHaveBeenCalledWith({
      header: { trdEnv: 0, accID: '11111', trdMarket: 1 },
      orderID: '77001',
      modifyOrderOp: 1, // ModifyOrderOp_Normal
      qty: 50,
      price: 10.5,
      auxPrice: undefined,
    })
  })

  it('rejects a modify request with no recognizable field changes', async () => {
    const gateway = makeGateway()
    const broker = makeBroker(gateway)
    await broker.init()
    const result = await broker.modifyOrder('77001', {})
    expect(result.success).toBe(false)
    expect(gateway.modifyOrder).not.toHaveBeenCalled()
  })

  it('cancels via ModifyOrderOp_Cancel and reports a Cancelled state', async () => {
    const gateway = makeGateway({ modifyOrder: vi.fn(async () => ({ orderID: '77001' })) })
    const broker = makeBroker(gateway)
    await broker.init()
    const result = await broker.cancelOrder('77001')
    expect(result.success).toBe(true)
    expect(result.orderState?.status).toBe('Cancelled')
    expect(gateway.modifyOrder).toHaveBeenCalledWith({
      header: { trdEnv: 0, accID: '11111', trdMarket: 1 },
      orderID: '77001',
      modifyOrderOp: 2, // ModifyOrderOp_Cancel
    })
  })
})

describe('FutuBroker.closePosition', () => {
  it('places an opposite-side market order sized to the open position', async () => {
    const gateway = makeGateway({
      getPositionList: vi.fn(async () => [
        { positionID: '1', positionSide: 0, code: '00700', name: 'Tencent', qty: 200, canSellQty: 200, price: 300, val: 60000, plVal: 100, secMarket: 1 },
      ]),
      placeOrder: vi.fn(async () => ({ orderID: '88001' })),
    })
    const broker = makeBroker(gateway)
    await broker.init()
    const result = await broker.closePosition(makeContract('HK.00700'))
    expect(result).toEqual({ success: true, orderId: '88001' })
    expect(gateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      trdSide: 2, // SELL to close a long
      orderType: 2, // MKT
      qty: 200,
    }))
  })

  it('errors when there is no open position for the contract', async () => {
    const broker = makeBroker(makeGateway({ getPositionList: vi.fn(async () => []) }))
    await broker.init()
    const result = await broker.closePosition(makeContract('HK.00700'))
    expect(result).toEqual({ success: false, error: expect.stringMatching(/no open position/i) })
  })
})

describe('FutuBroker.getOrders / getOrder', () => {
  const ORDER_ROW = {
    trdSide: 1, orderType: 1, orderStatus: 5, orderID: '77001', orderIDEx: 'ex-1',
    code: '00700', name: 'Tencent', qty: 100, price: 123.4, createTime: '2024-01-01 09:30:00',
    updateTime: '2024-01-01 09:30:01', fillQty: 0, secMarket: 1,
  }

  it('maps Trd_Common.Order rows into OpenOrder with IBKR-style status', async () => {
    const gateway = makeGateway({ getOrderList: vi.fn(async () => [ORDER_ROW]) })
    const broker = makeBroker(gateway)
    await broker.init()
    const orders = await broker.getOrders(['77001'])
    expect(orders).toHaveLength(1)
    expect(orders[0].orderId).toBe('77001')
    expect(orders[0].order.action).toBe('BUY')
    expect(orders[0].order.orderType).toBe('LMT')
    expect(orders[0].orderState.status).toBe('Submitted')
    expect(orders[0].contract.symbol).toBe('00700')
  })

  it('getOrder finds the matching row by id and returns null otherwise', async () => {
    const gateway = makeGateway({ getOrderList: vi.fn(async () => [ORDER_ROW]) })
    const broker = makeBroker(gateway)
    await broker.init()
    expect((await broker.getOrder('77001'))?.orderId).toBe('77001')
    expect(await broker.getOrder('does-not-exist')).toBeNull()
  })

  it('maps a filled order status to Filled', async () => {
    const gateway = makeGateway({ getOrderList: vi.fn(async () => [{ ...ORDER_ROW, orderStatus: 11 }]) })
    const broker = makeBroker(gateway)
    await broker.init()
    const orders = await broker.getOrders(['77001'])
    expect(orders[0].orderState.status).toBe('Filled')
  })

  it('falls back to a 1-month Trd_GetHistoryOrderList window for orders missing from today\'s list', async () => {
    const overnight = { ...ORDER_ROW, orderID: '66001' }
    const gateway = makeGateway({
      getOrderList: vi.fn(async () => []),
      getHistoryOrderList: vi.fn(async () => [overnight]),
    })
    const broker = makeBroker(gateway)
    await broker.init()

    const order = await broker.getOrder('66001')
    expect(order?.orderId).toBe('66001')

    expect(gateway.getHistoryOrderList).toHaveBeenCalledWith(
      { trdEnv: 0, accID: '11111', trdMarket: 1 },
      expect.objectContaining({
        idList: ['66001'],
        beginTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
        endTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      }),
    )
    // The window really is ~one month wide.
    const [, filter] = (gateway.getHistoryOrderList as ReturnType<typeof vi.fn>).mock.calls[0]
    const spanDays = (new Date(filter.endTime).getTime() - new Date(filter.beginTime).getTime()) / 86_400_000
    expect(spanDays).toBeGreaterThanOrEqual(30)
    expect(spanDays).toBeLessThanOrEqual(32)
  })

  it('skips the history call entirely when today\'s list already resolves every id', async () => {
    const gateway = makeGateway({ getOrderList: vi.fn(async () => [ORDER_ROW]) })
    const broker = makeBroker(gateway)
    await broker.init()
    await broker.getOrders(['77001'])
    expect(gateway.getHistoryOrderList).not.toHaveBeenCalled()
  })

  it('serves pushed order updates from the cache without touching the wire', async () => {
    let push: ((order: (typeof ORDER_ROW)) => void) | undefined
    const gateway = makeGateway({
      subscribeOrderUpdates: vi.fn(async (_accID: unknown, onUpdate: (order: typeof ORDER_ROW) => void) => { push = onUpdate }),
      getOrderList: vi.fn(async () => []),
    })
    const broker = makeBroker(gateway)
    await broker.init()

    push!({ ...ORDER_ROW, orderStatus: 11 })
    const order = await broker.getOrder('77001')

    expect(order?.orderState.status).toBe('Filled')
    expect(gateway.getOrderList).not.toHaveBeenCalled()
    expect(gateway.getHistoryOrderList).not.toHaveBeenCalled()
  })

  it('a fill push invalidates the cached order row so the next read re-pulls', async () => {
    let push: ((order: typeof ORDER_ROW) => void) | undefined
    let pushFill: ((fill: { orderID?: string }) => void) | undefined
    const gateway = makeGateway({
      subscribeOrderUpdates: vi.fn(async (
        _accID: unknown,
        onUpdate: (order: typeof ORDER_ROW) => void,
        onFill?: (fill: { orderID?: string }) => void,
      ) => { push = onUpdate; pushFill = onFill }),
      getOrderList: vi.fn(async () => [{ ...ORDER_ROW, orderStatus: 10 }]),
    })
    const broker = makeBroker(gateway)
    await broker.init()

    push!(ORDER_ROW) // cached as Submitted
    pushFill!({ orderID: '77001' }) // a fill arrived — cached row is stale now

    const order = await broker.getOrder('77001')
    expect(gateway.getOrderList).toHaveBeenCalled()
    expect(order?.orderState.status).toBe('Submitted') // FilledPart maps to Submitted (still active)
  })

  it('enriches fee-bearing orders with real charged fees from Trd_GetOrderFee', async () => {
    const filled = { ...ORDER_ROW, orderStatus: 11, currency: 1 } // FilledAll, HKD
    const gateway = makeGateway({
      getOrderList: vi.fn(async () => [filled]),
      getOrderFee: vi.fn(async () => [{ orderIDEx: 'ex-1', feeAmount: 15.5 }]),
    })
    const broker = makeBroker(gateway)
    await broker.init()

    const order = await broker.getOrder('77001')

    expect(gateway.getOrderFee).toHaveBeenCalledWith({ trdEnv: 0, accID: '11111', trdMarket: 1 }, ['ex-1'])
    expect(order?.orderState.commissionAndFees).toBe(15.5)
    expect(order?.orderState.commissionAndFeesCurrency).toBe('HKD')

    // Second read hits the immutable fee cache — no repeat wire call.
    await broker.getOrder('77001')
    expect(gateway.getOrderFee).toHaveBeenCalledTimes(1)
  })

  it('skips fee lookup entirely for orders without fills', async () => {
    const gateway = makeGateway({ getOrderList: vi.fn(async () => [ORDER_ROW]) }) // Submitted
    const broker = makeBroker(gateway)
    await broker.init()
    await broker.getOrder('77001')
    expect(gateway.getOrderFee).not.toHaveBeenCalled()
  })

  it('a failed fee lookup is non-fatal and leaves fees unset', async () => {
    const filled = { ...ORDER_ROW, orderStatus: 11 }
    const gateway = makeGateway({
      getOrderList: vi.fn(async () => [filled]),
      getOrderFee: vi.fn(async () => { throw new Error('fee endpoint down') }),
    })
    const broker = makeBroker(gateway)
    await broker.init()

    const order = await broker.getOrder('77001')
    expect(order).not.toBeNull()
    // UNSET_DOUBLE sentinel means "no fee data", never a fabricated 0.
    expect(order?.orderState.commissionAndFeesCurrency).toBe('')
  })
})

// ==================== Connection state ====================

describe('FutuBroker connection state', () => {
  const ORDER_ROW = {
    trdSide: 1, orderType: 1, orderStatus: 5, orderID: '77001', orderIDEx: 'ex-1',
    code: '00700', name: 'Tencent', qty: 100, createTime: '', updateTime: '', secMarket: 1,
  }

  function makeConnectableGateway(overrides: Parameters<typeof makeGateway>[0] = {}) {
    let listener: ((event: { state: 'dead' | 'restored'; error?: string }) => void) | null = null
    const gateway = makeGateway({
      setConnectionListener: vi.fn((l: ((event: { state: 'dead' | 'restored'; error?: string }) => void) | null) => { listener = l }),
      ...overrides,
    })
    return { gateway, fire: (event: { state: 'dead' | 'restored'; error?: string }) => listener?.(event) }
  }

  it('forwards gateway dead events to the registered IBroker listener', async () => {
    const { gateway, fire } = makeConnectableGateway()
    const broker = makeBroker(gateway)
    const events: unknown[] = []
    broker.setConnectionStateListener((e) => events.push(e))
    await broker.init()

    fire({ state: 'dead', error: 'socket closed' })

    expect(events).toEqual([{ state: 'dead', error: 'socket closed' }])
  })

  it('forwards restored events and re-runs trade unlock (OpenD may have restarted)', async () => {
    const { gateway, fire } = makeConnectableGateway()
    const parsed = FutuBroker.configSchema.parse({ trdEnv: 'simulate', trdMarket: 'HK', tradePassword: 'hunter2' })
    const broker = new FutuBroker({ ...parsed, id: 'futu-test' }, () => gateway)
    const events: unknown[] = []
    broker.setConnectionStateListener((e) => events.push(e))
    await broker.init()
    expect(gateway.unlockTrade).toHaveBeenCalledTimes(1)

    fire({ state: 'restored' })
    await vi.waitFor(() => expect(gateway.unlockTrade).toHaveBeenCalledTimes(2))
    expect(events).toEqual([{ state: 'restored' }])
  })

  it('clears the push cache on any transport interruption', async () => {
    let push: ((order: typeof ORDER_ROW) => void) | undefined
    const { gateway, fire } = makeConnectableGateway({
      subscribeOrderUpdates: vi.fn(async (_accID: unknown, onUpdate: (order: typeof ORDER_ROW) => void) => { push = onUpdate }),
      getOrderList: vi.fn(async () => []),
    })
    const broker = makeBroker(gateway)
    await broker.init()
    push!(ORDER_ROW)

    fire({ state: 'dead', error: 'gone' })

    // Cache no longer trusted — the lookup must go back to the wire.
    expect(await broker.getOrder('77001')).toBeNull()
    expect(gateway.getOrderList).toHaveBeenCalled()
  })

  it('re-running init stops the previous gateway so no zombie connection survives recovery', async () => {
    const gateway = makeGateway()
    const broker = makeBroker(gateway)
    await broker.init()
    await broker.init()
    expect(gateway.stop).toHaveBeenCalledTimes(1)
  })

  it('order-push subscription failure is non-fatal (polling still works)', async () => {
    const gateway = makeGateway({
      subscribeOrderUpdates: vi.fn(async () => { throw new Error('SubAccPush rejected') }),
    })
    const broker = makeBroker(gateway)
    await expect(broker.init()).resolves.toBeUndefined()
  })
})

describe('FutuBroker capabilities', () => {
  it('declares single-leg equity order types now that writes are implemented', async () => {
    const broker = makeBroker(makeGateway())
    expect(broker.getCapabilities()).toEqual({
      supportedSecTypes: ['STK'],
      supportedOrderTypes: ['MKT', 'LMT', 'STP', 'STP LMT'],
      historicalBars: {
        supported: true,
        quality: 'subscription',
        supportedBarSizes: ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'],
      },
    })
  })
})

// ==================== Historical K-lines ====================

describe('FutuBroker.getHistorical', () => {
  const KL_ROW = {
    time: '2024-06-03 00:00:00', isBlank: false,
    openPrice: 100, highPrice: 110, lowPrice: 95, closePrice: 105,
    volume: 1_000_000, timestamp: 1_717_372_800,
  }

  it('requests forward-adjusted K-lines with the mapped KLType and a derived window', async () => {
    const gateway = makeGateway({ requestHistoryKL: vi.fn(async () => ({ klList: [KL_ROW] })) })
    const broker = makeBroker(gateway)
    await broker.init()

    const bars = await broker.getHistorical(makeContract('HK.00700'), { interval: '1d', limit: 10 })

    expect(bars).toHaveLength(1)
    expect(bars[0]).toEqual({
      timestamp: new Date(1_717_372_800 * 1000),
      open: '100', high: '110', low: '95', close: '105', volume: '1000000',
    })
    expect(gateway.requestHistoryKL).toHaveBeenCalledWith(expect.objectContaining({
      security: { market: 1, code: '00700' },
      rehabType: 1, // RehabType_Forward
      klType: 2, // KLType_Day
      beginTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      endTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    }))
    const [args] = (gateway.requestHistoryKL as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(new Date(args.beginTime).getTime()).toBeLessThan(new Date(args.endTime).getTime())
  })

  it('maps every BarInterval onto a Futu KLType', async () => {
    const gateway = makeGateway({ requestHistoryKL: vi.fn(async () => ({ klList: [] })) })
    const broker = makeBroker(gateway)
    await broker.init()
    const expected: Array<[string, number]> = [
      ['1m', 1], ['5m', 6], ['15m', 7], ['30m', 8], ['1h', 9], ['4h', 15], ['1d', 2], ['1w', 3],
    ]
    for (const [interval, klType] of expected) {
      await broker.getHistorical(makeContract('US.AAPL'), { interval: interval as '1d' })
      expect(gateway.requestHistoryKL).toHaveBeenLastCalledWith(expect.objectContaining({ klType }))
    }
  })

  it('follows nextReqKey pagination until the final page', async () => {
    const page1 = { klList: [{ ...KL_ROW, timestamp: 1_717_286_400 }], nextReqKey: 'cursor-1' }
    const page2 = { klList: [KL_ROW] }
    const requestHistoryKL = vi.fn(async () => page2).mockImplementationOnce(async () => page1)
    const gateway = makeGateway({ requestHistoryKL })
    const broker = makeBroker(gateway)
    await broker.init()

    const bars = await broker.getHistorical(makeContract('HK.00700'), { interval: '1d' })

    expect(bars).toHaveLength(2)
    expect(requestHistoryKL).toHaveBeenCalledTimes(2)
    expect(requestHistoryKL.mock.calls[1][0]).toEqual(expect.objectContaining({ nextReqKey: 'cursor-1' }))
    // Ascending order after sort.
    expect(bars[0].timestamp.getTime()).toBeLessThan(bars[1].timestamp.getTime())
  })

  it('drops blank placeholder rows and rows missing OHLC instead of zero-filling', async () => {
    const gateway = makeGateway({
      requestHistoryKL: vi.fn(async () => ({
        klList: [
          { time: '2024-06-01 00:00:00', isBlank: true },
          { ...KL_ROW, openPrice: undefined },
          KL_ROW,
        ],
      })),
    })
    const broker = makeBroker(gateway)
    await broker.init()
    const bars = await broker.getHistorical(makeContract('HK.00700'), { interval: '1d' })
    expect(bars).toHaveLength(1)
  })

  it('tail-slices to the most recent `limit` bars', async () => {
    const rows = [1, 2, 3, 4, 5].map((d) => ({ ...KL_ROW, timestamp: 1_717_286_400 + d * 86_400 }))
    const gateway = makeGateway({ requestHistoryKL: vi.fn(async () => ({ klList: rows })) })
    const broker = makeBroker(gateway)
    await broker.init()
    const bars = await broker.getHistorical(makeContract('HK.00700'), { interval: '1d', limit: 2 })
    expect(bars).toHaveLength(2)
    expect(bars[1].timestamp).toEqual(new Date((1_717_286_400 + 5 * 86_400) * 1000))
  })

  it('wraps gateway failures as BrokerError', async () => {
    const gateway = makeGateway({ requestHistoryKL: vi.fn(async () => { throw new Error('quota exceeded') }) })
    const broker = makeBroker(gateway)
    await broker.init()
    await expect(broker.getHistorical(makeContract('HK.00700'), { interval: '1d' })).rejects.toThrow(/quota exceeded/)
  })
})

// ==================== Trade unlock ====================

describe('FutuBroker trade unlock', () => {
  it('unlocks trading with the MD5 hash of the configured password', async () => {
    const gateway = makeGateway({ unlockTrade: vi.fn(async () => {}) })
    const parsed = FutuBroker.configSchema.parse({ trdEnv: 'simulate', trdMarket: 'HK', tradePassword: 'hunter2' })
    const broker = new FutuBroker({ ...parsed, id: 'futu-test' }, () => gateway)
    await broker.init()
    const expectedMD5 = createHash('md5').update('hunter2').digest('hex')
    expect(gateway.unlockTrade).toHaveBeenCalledWith(expectedMD5)
  })

  it('skips unlock entirely when no trade password is configured', async () => {
    const gateway = makeGateway({ unlockTrade: vi.fn(async () => {}) })
    const broker = makeBroker(gateway)
    await broker.init()
    expect(gateway.unlockTrade).not.toHaveBeenCalled()
  })

  it('does not fail init when unlock itself fails (reads must still work)', async () => {
    const gateway = makeGateway({ unlockTrade: vi.fn(async () => { throw new Error('wrong trade password') }) })
    const parsed = FutuBroker.configSchema.parse({ trdEnv: 'simulate', trdMarket: 'HK', tradePassword: 'wrong' })
    const broker = new FutuBroker({ ...parsed, id: 'futu-test' }, () => gateway)
    await expect(broker.init()).resolves.toBeUndefined()
    await expect(broker.getAccount()).resolves.toBeDefined()
  })
})

// ==================== Native key ====================

describe('FutuBroker native key', () => {
  it('round-trips getNativeKey/resolveNativeKey', () => {
    const broker = makeBroker(makeGateway())
    const contract = makeContract('HK.00700')
    const key = broker.getNativeKey(contract)
    expect(key).toBe('HK.00700')
    expect(broker.resolveNativeKey(key).localSymbol).toBe('HK.00700')
  })
})

// ==================== subscribeQuote (live push) ====================

describe('FutuBroker.subscribeQuote', () => {
  it('subscribes via the gateway and maps pushed BasicQot rows (no bid/ask)', async () => {
    let capturedOnUpdate: ((rows: unknown[]) => void) | null = null
    const unsubscribe = vi.fn(async () => {})
    const gateway = makeGateway({
      subscribeBasicQuote: vi.fn(async (securities, onUpdate) => {
        expect(securities).toEqual([{ market: 1, code: '00700' }])
        capturedOnUpdate = onUpdate as (rows: unknown[]) => void
        return unsubscribe
      }),
    })
    const broker = makeBroker(gateway)
    await broker.init()

    const updates: unknown[] = []
    const stop = await broker.subscribeQuote(makeContract('HK.00700'), (u) => updates.push(u))

    expect(gateway.subscribeBasicQuote).toHaveBeenCalledTimes(1)
    expect(capturedOnUpdate).not.toBeNull()

    // Simulate a Qot_UpdateBasicQot push arriving.
    capturedOnUpdate!([{
      security: { market: 1, code: '00700' }, isSuspended: false, updateTime: '2026-08-26 10:00:00',
      highPrice: 630, openPrice: 615, lowPrice: 612, curPrice: 620.5, lastClosePrice: 618,
      volume: '1234567', turnover: 7.6e8, updateTimestamp: 1_750_000_000,
    }])

    expect(updates).toEqual([{
      contract: expect.objectContaining({ localSymbol: 'HK.00700' }),
      last: '620.5', high: '630', low: '612', open: '615', lastClose: '618',
      volume: '1234567', turnover: '760000000',
      timestamp: new Date(1_750_000_000 * 1000),
    }])

    await stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('delivers only the matching security to each of two overlapping subscriptions', async () => {
    const listeners: Array<(rows: unknown[]) => void> = []
    const unsubA = vi.fn(async () => {})
    const unsubB = vi.fn(async () => {})
    let call = 0
    const gateway = makeGateway({
      subscribeBasicQuote: vi.fn(async (_securities, onUpdate) => {
        listeners.push(onUpdate as (rows: unknown[]) => void)
        call += 1
        return call === 1 ? unsubA : unsubB
      }),
    })
    const broker = makeBroker(gateway)
    await broker.init()

    const aUpdates: unknown[] = []
    const bUpdates: unknown[] = []
    await broker.subscribeQuote(makeContract('HK.00700'), (u) => aUpdates.push(u))
    await broker.subscribeQuote(makeContract('US.AAPL'), (u) => bUpdates.push(u))

    // Each subscribeBasicQuote call is independent in this fake (mirrors how
    // FutuGatewayClient fans push out per-subscription in the real
    // implementation) — push only the row for HK.00700 to the first listener.
    listeners[0]([{
      security: { market: 1, code: '00700' }, isSuspended: false, updateTime: '',
      highPrice: 1, openPrice: 1, lowPrice: 1, curPrice: 1, lastClosePrice: 1, volume: 0, turnover: 0,
    }])

    expect(aUpdates).toHaveLength(1)
    expect(bUpdates).toHaveLength(0)
  })

  it('refuses when the contract cannot be resolved to a Futu key', async () => {
    const broker = makeBroker(makeGateway())
    await broker.init()
    await expect(broker.subscribeQuote(new Contract(), () => {})).rejects.toMatchObject({ name: 'BrokerError', code: 'EXCHANGE' })
  })

  it('wraps a gateway subscribe failure as a BrokerError', async () => {
    const gateway = makeGateway({ subscribeBasicQuote: vi.fn(async () => { throw new Error('not entitled for real-time quotes') }) })
    const broker = makeBroker(gateway)
    await broker.init()
    await expect(broker.subscribeQuote(makeContract('HK.00700'), () => {})).rejects.toMatchObject({ name: 'BrokerError' })
  })
})

