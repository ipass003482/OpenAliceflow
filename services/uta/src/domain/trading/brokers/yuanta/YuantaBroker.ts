import { Contract, ContractDescription, Order, OrderState, UNSET_DECIMAL } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { z } from 'zod'
import type {
  AccountCapabilities,
  AccountInfo,
  IBroker,
  MarketClock,
  OpenOrder,
  PlaceOrderResult,
  Position,
  Quote,
  TpSlParams,
} from '../types.js'
import { BrokerError } from '../types.js'
import { buildPosition } from '../contract-builder.js'
import { YuantaBridgeClient } from './YuantaBridgeClient.js'
import { makeYuantaContract, resolveYuantaKey, yuantaDescription } from './yuanta-contracts.js'
import type { YuantaBridgeConfig, YuantaOrderRow, YuantaPositionRow } from './yuanta-types.js'

const configSchema = z.object({
  environment: z.literal('uat'),
  account: z.string().regex(/^S\d{11}$/),
  password: z.string().min(1),
  runtimeDir: z.string().optional(),
  bridgePath: z.string().optional(),
})

type Config = z.infer<typeof configSchema>

export class YuantaBroker implements IBroker {
  static readonly configSchema = configSchema
  readonly meta = { environment: 'uat' as const, market: 'TW' as const }
  private readonly bridge: YuantaBridgeClient

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly config: Config,
    bridge?: YuantaBridgeClient,
  ) {
    this.bridge = bridge ?? new YuantaBridgeClient(config as YuantaBridgeConfig)
  }

  static fromConfig(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }): YuantaBroker {
    const parsed = configSchema.parse(config.brokerConfig)
    return new YuantaBroker(config.id, config.label ?? config.id, parsed)
  }

  async init(): Promise<void> {
    try { await this.bridge.init() } catch (err) { throw BrokerError.from(err, 'NETWORK') }
  }

  async close(): Promise<void> { await this.bridge.close() }

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    const query = pattern.trim()
    if (!query) return []
    try {
      const rows = await this.bridge.call<Array<Record<string, unknown>>>('searchContracts', { pattern: query })
      return rows.map((row) => {
        const code = text(row, 'stockCode', 'StockCode', 'StkCode') || query
        const market = normalizeMarket(text(row, 'marketType', 'MarketType', 'MarketNo'))
        return yuantaDescription(`${market}:${code}`, text(row, 'stockName', 'StockName', 'Name'))
      })
    } catch {
      if (!/^\d{4,6}$/.test(query)) return []
      return [yuantaDescription(`TWSE:${query}`), yuantaDescription(`TPEx:${query}`)]
    }
  }

  async getContractDetails(query: Contract) {
    const key = resolveYuantaKey(query)
    if (!key) return null
    const rows = await this.searchContracts(key.split(':')[1] ?? key)
    const found = rows.find((row) => resolveYuantaKey(row.contract) === key)
    if (!found) return null
    return { contract: found.contract } as never
  }

  async placeOrder(contract: Contract, order: Order, tpsl?: TpSlParams): Promise<PlaceOrderResult> {
    if (tpsl?.takeProfit || tpsl?.stopLoss) return { success: false, error: 'Yuanta UAT v1 does not support attached TP/SL orders.' }
    const key = resolveYuantaKey(contract)
    if (!key) return { success: false, error: 'Cannot resolve Taiwan-equity contract.' }
    if (!['BUY', 'SELL'].includes(order.action)) return { success: false, error: `Unsupported action: ${order.action || '(empty)'}` }
    if (!['MKT', 'LMT'].includes(order.orderType)) return { success: false, error: 'Yuanta UAT v1 supports MKT and LMT orders only.' }
    if (order.totalQuantity.equals(UNSET_DECIMAL) || order.totalQuantity.lte(0) || !order.totalQuantity.isInteger()) {
      return { success: false, error: 'Taiwan-equity quantity must be a positive whole number of shares.' }
    }
    if (order.orderType === 'LMT' && order.lmtPrice.equals(UNSET_DECIMAL)) return { success: false, error: 'Limit price is required.' }
    const { market, code } = splitKey(key)
    try {
      const result = await this.bridge.call<Record<string, unknown>>('placeStockOrder', {
        market,
        stockCode: code,
        side: order.action,
        quantity: order.totalQuantity.toString(),
        orderType: order.orderType,
        price: order.orderType === 'LMT' ? order.lmtPrice.toString() : '0',
        timeInForce: normalizeTif(order.tif),
        oddLot: !order.totalQuantity.mod(1000).isZero(),
      })
      const orderId = text(result, 'orderNo', 'OrderNo', 'orderId', 'OrderId')
      return orderId ? { success: true, orderId } : { success: false, error: 'Yuanta accepted the request but returned no order number.' }
    } catch (err) { return { success: false, error: BrokerError.from(err, 'EXCHANGE').message } }
  }

  async modifyOrder(orderId: string, changes: Partial<Order>): Promise<PlaceOrderResult> {
    const quantity = changes.totalQuantity && !changes.totalQuantity.equals(UNSET_DECIMAL) ? changes.totalQuantity.toString() : undefined
    const price = changes.lmtPrice && !changes.lmtPrice.equals(UNSET_DECIMAL) ? changes.lmtPrice.toString() : undefined
    if (!quantity && !price) return { success: false, error: 'Provide a new quantity or limit price.' }
    try {
      await this.bridge.call('modifyStockOrder', { orderNo: orderId, quantity, price })
      return { success: true, orderId }
    } catch (err) { return { success: false, error: BrokerError.from(err, 'EXCHANGE').message } }
  }

  async cancelOrder(orderId: string): Promise<PlaceOrderResult> {
    try {
      await this.bridge.call('cancelStockOrder', { orderNo: orderId })
      const state = new OrderState()
      state.status = 'Cancelled'
      return { success: true, orderId, orderState: state }
    } catch (err) { return { success: false, error: BrokerError.from(err, 'EXCHANGE').message } }
  }

  async closePosition(contract: Contract, quantity?: Decimal): Promise<PlaceOrderResult> {
    const key = resolveYuantaKey(contract)
    const position = (await this.getPositions()).find((row) => resolveYuantaKey(row.contract) === key)
    if (!position) return { success: false, error: 'No matching Yuanta position.' }
    const order = new Order()
    order.action = position.side === 'long' ? 'SELL' : 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = quantity && quantity.gt(0) ? Decimal.min(quantity, position.quantity) : position.quantity
    return this.placeOrder(contract, order)
  }

  async getAccount(): Promise<AccountInfo> {
    const row = await this.bridge.call<Record<string, unknown>>('getAccount')
    return {
      baseCurrency: 'TWD',
      netLiquidation: decimalText(value(row, 'netLiquidation', 'NetLiquidation', 'TotalAssets')),
      totalCashValue: decimalText(value(row, 'totalCashValue', 'TotalCashValue', 'BankBalance')),
      unrealizedPnL: decimalText(value(row, 'unrealizedPnL', 'UnrealizedPnL', 'UnrealizedProfitLoss')),
      realizedPnL: decimalText(value(row, 'realizedPnL', 'RealizedPnL', 'RealizedProfitLoss')),
      buyingPower: decimalText(value(row, 'buyingPower', 'BuyingPower', 'AvailableAmount')),
    }
  }

  async getPositions(): Promise<Position[]> {
    const rows = await this.bridge.call<YuantaPositionRow[]>('getPositions')
    return rows.flatMap((row) => {
      const quantity = new Decimal(String(value(row, 'quantity', 'balanceQty', 'BalanceQty', 'Qty') ?? 0))
      if (quantity.isZero()) return []
      const code = text(row, 'stockCode', 'StockCode', 'StkCode')
      if (!code) return []
      return [buildPosition({
        contract: makeYuantaContract(`${normalizeMarket(String(value(row, 'marketType', 'MarketType') ?? 'TWSE'))}:${code}`, text(row, 'stockName', 'StockName')),
        currency: 'TWD',
        side: quantity.isNegative() ? 'short' : 'long',
        quantity: quantity.abs(),
        avgCost: decimalText(value(row, 'costPrice', 'CostPrice', 'AvgPrice')),
        marketPrice: decimalText(value(row, 'marketPrice', 'MarketPrice', 'DealPrice')),
        marketValue: decimalText(value(row, 'marketValue', 'MarketValue')),
        unrealizedPnL: decimalText(value(row, 'unrealizedProfitLoss', 'UnrealizedProfitLoss', 'UnrealizedPnL')),
        realizedPnL: decimalText(value(row, 'realizedProfitLoss', 'RealizedProfitLoss', 'RealizedPnL')),
        multiplier: '1',
      })]
    })
  }

  async getOrders(orderIds: string[]): Promise<OpenOrder[]> {
    const rows = await this.bridge.call<YuantaOrderRow[]>('getOrders', { orderIds })
    return rows.filter((row) => !orderIds.length || orderIds.includes(text(row, 'orderNo', 'OrderNo'))).map(toOpenOrder)
  }

  async getOrder(orderId: string): Promise<OpenOrder | null> { return (await this.getOrders([orderId]))[0] ?? null }
  async getOpenOrders(): Promise<OpenOrder[]> { return (await this.bridge.call<YuantaOrderRow[]>('getOrders', { openOnly: true })).map(toOpenOrder) }

  async getQuote(contract: Contract): Promise<Quote> {
    const key = resolveYuantaKey(contract)
    if (!key) throw new BrokerError('EXCHANGE', 'Cannot resolve Taiwan-equity contract.')
    const { market, code } = splitKey(key)
    const row = await this.bridge.call<Record<string, unknown>>('getQuote', { market, stockCode: code })
    return {
      contract: makeYuantaContract(key),
      last: decimalText(value(row, 'last', 'Last', 'DealPrice')),
      bid: decimalText(value(row, 'bid', 'Bid', 'BidPrice')),
      ask: decimalText(value(row, 'ask', 'Ask', 'AskPrice')),
      volume: decimalText(value(row, 'volume', 'Volume', 'DealVol')),
      high: decimalText(value(row, 'high', 'High', 'HighPrice')),
      low: decimalText(value(row, 'low', 'Low', 'LowPrice')),
      timestamp: new Date(String(value(row, 'timestamp', 'Timestamp', 'Time') ?? Date.now())),
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    const now = new Date()
    const taipei = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
    const minutes = taipei.getHours() * 60 + taipei.getMinutes()
    return { isOpen: taipei.getDay() >= 1 && taipei.getDay() <= 5 && minutes >= 9 * 60 && minutes < 13 * 60 + 30, timestamp: now }
  }

  assetClassFor(): 'equity' { return 'equity' }
  getCapabilities(): AccountCapabilities { return { supportedSecTypes: ['STK'], supportedOrderTypes: ['MKT', 'LMT'] } }
  getNativeKey(contract: Contract): string { return resolveYuantaKey(contract) ?? contract.symbol ?? '' }
  resolveNativeKey(nativeKey: string): Contract { return makeYuantaContract(nativeKey) }
}

function toOpenOrder(row: YuantaOrderRow): OpenOrder {
  const order = new Order()
  order.action = text(row, 'buySell', 'BuySell').toUpperCase().startsWith('B') ? 'BUY' : 'SELL'
  order.totalQuantity = new Decimal(String(value(row, 'orderQty', 'OrderQty') ?? 0))
  order.filledQuantity = new Decimal(String(value(row, 'dealQty', 'DealQty') ?? 0))
  order.orderType = text(row, 'priceFlag', 'PriceFlag').trim() === 'M' ? 'MKT' : 'LMT'
  order.lmtPrice = new Decimal(String(value(row, 'price', 'Price') ?? 0))
  const state = new OrderState()
  state.status = normalizeStatus(text(row, 'orderStatus', 'OrderStatus'))
  const code = text(row, 'stockCode', 'StockCode', 'StkCode')
  return {
    contract: makeYuantaContract(`TWSE:${code}`),
    order,
    orderState: state,
    orderId: text(row, 'orderNo', 'OrderNo'),
    avgFillPrice: decimalText(value(row, 'dealPrice', 'DealPrice')),
  }
}

function value(row: object, ...keys: string[]): unknown {
  const record = row as Record<string, unknown>
  for (const key of keys) if (record[key] !== undefined) return record[key]
  const lowered = new Map(Object.entries(record).map(([key, val]) => [key.toLowerCase(), val]))
  for (const key of keys) if (lowered.has(key.toLowerCase())) return lowered.get(key.toLowerCase())
  return undefined
}
function text(row: object, ...keys: string[]): string { return String(value(row, ...keys) ?? '') }
function decimalText(input: unknown): string { try { return new Decimal(String(input ?? 0)).toString() } catch { return '0' } }
function normalizeMarket(input: string): 'TWSE' | 'TPEx' { return /tpex|otc|上櫃|2/i.test(input) ? 'TPEx' : 'TWSE' }
function splitKey(key: string): { market: 'TWSE' | 'TPEx'; code: string } { const [market, code] = key.split(':'); return { market: normalizeMarket(market ?? ''), code: code ?? market ?? '' } }
function normalizeTif(tif: string): 'ROD' | 'IOC' | 'FOK' { return tif === 'IOC' || tif === 'FOK' ? tif : 'ROD' }
function normalizeStatus(status: string): string {
  if (/成交|filled/i.test(status)) return 'Filled'
  if (/取消|cancel/i.test(status)) return 'Cancelled'
  if (/拒絕|reject|error/i.test(status)) return 'Inactive'
  if (/部分|partial/i.test(status)) return 'Submitted'
  return 'Submitted'
}
