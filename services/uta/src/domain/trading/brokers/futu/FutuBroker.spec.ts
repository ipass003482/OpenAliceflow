import { describe, it, expect, vi } from 'vitest'
import Decimal from 'decimal.js'
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
      { trdEnv: 0, accID: '11111', trdMarketAuthList: [1, 2] },
      { trdEnv: 1, accID: '22222', trdMarketAuthList: [1, 2] },
    ]),
    getFunds: vi.fn(async () => null),
    getPositionList: vi.fn(async () => []),
    getSecuritySnapshot: vi.fn(async () => []),
    getStaticInfo: vi.fn(async () => []),
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
        { trdEnv: 0, accID: '11111', trdMarketAuthList: [1] },
        { trdEnv: 0, accID: '33333', trdMarketAuthList: [1] },
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

// ==================== Read-only refusal ====================

describe('FutuBroker read-only refusal', () => {
  it('refuses every order write without touching the gateway', async () => {
    const gateway = makeGateway()
    const broker = makeBroker(gateway)
    await broker.init()
    const order = new Order()
    const results = await Promise.all([
      broker.placeOrder(makeContract('HK.00700'), order),
      broker.modifyOrder('1', {}),
      broker.cancelOrder('1'),
      broker.closePosition(makeContract('HK.00700')),
    ])
    for (const r of results) {
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/read-only/i)
    }
    expect(await broker.getOrders(['1'])).toEqual([])
  })

  it('declares no supported order types', async () => {
    const broker = makeBroker(makeGateway())
    expect(broker.getCapabilities()).toEqual({ supportedSecTypes: ['STK'], supportedOrderTypes: [] })
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
