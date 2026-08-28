import { describe, expect, it } from 'vitest'
import { Order } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { YuantaBroker } from './YuantaBroker.js'
import { YuantaBridgeClient } from './YuantaBridgeClient.js'
import { makeYuantaContract, parseYuantaKey, resolveYuantaKey } from './yuanta-contracts.js'

class FakeBridge {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  async init() {}
  async close() {}
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'placeStockOrder') return { OrderNo: 'A001' } as T
    if (method === 'getPositions') return [{ StockCode: '2330', BalanceQty: '2000', CostPrice: '900', MarketPrice: '950', MarketValue: '1900000', UnrealizedProfitLoss: '100000', MarketType: 'TWSE' }] as T
    if (method === 'getAccount') return { BankBalance: '500000', TotalAssets: '2400000', UnrealizedProfitLoss: '100000' } as T
    return [] as T
  }
}

function broker(fake = new FakeBridge()) {
  return {
    fake,
    broker: new YuantaBroker('yuanta-uat', 'Yuanta UAT', {
      environment: 'uat',
      account: 'S98875005091',
      password: 'test-password',
    }, fake as unknown as YuantaBridgeClient),
  }
}

describe('Yuanta Taiwan-equity contract identity', () => {
  it('round-trips TWSE and TPEx native keys', () => {
    expect(parseYuantaKey('TPEx:6488')).toEqual({ market: 'TPEx', code: '6488' })
    expect(resolveYuantaKey(makeYuantaContract('TWSE:2330'))).toBe('TWSE:2330')
  })
})

describe('YuantaBroker UAT safety and mappings', () => {
  it('has no production configuration path', () => {
    expect(() => YuantaBroker.fromConfig({ id: 'x', brokerConfig: { environment: 'prod', account: 'S98875005091', password: 'x' } })).toThrow()
  })

  it('maps whole-share and intraday odd-lot orders explicitly', async () => {
    const { broker: instance, fake } = broker()
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'LMT'
    order.totalQuantity = new Decimal(100)
    order.lmtPrice = new Decimal('950')
    const result = await instance.placeOrder(makeYuantaContract('TWSE:2330'), order)
    expect(result).toEqual({ success: true, orderId: 'A001' })
    expect(fake.calls[0]).toMatchObject({
      method: 'placeStockOrder',
      params: { market: 'TWSE', stockCode: '2330', quantity: '100', oddLot: true, orderType: 'LMT' },
    })
  })

  it('rejects fractional shares before reaching SPARK', async () => {
    const { broker: instance, fake } = broker()
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('1.5')
    await expect(instance.placeOrder(makeYuantaContract('TWSE:2330'), order)).resolves.toMatchObject({ success: false })
    expect(fake.calls).toHaveLength(0)
  })

  it('normalizes TWD positions without applying a lot multiplier', async () => {
    const { broker: instance } = broker()
    const [position] = await instance.getPositions()
    expect(position.quantity.toString()).toBe('2000')
    expect(position.multiplier).toBe('1')
    expect(position.currency).toBe('TWD')
    expect(position.unrealizedPnL).toBe('100000')
  })
})
