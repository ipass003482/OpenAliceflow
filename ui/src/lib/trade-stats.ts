import Decimal from 'decimal.js'
import type { EquityCurvePoint, OrderHistoryEntry, TradeHistoryEntry } from '../api/types'

export interface ClosedRoundTrip {
  contractKey: string
  side: 'LONG' | 'SHORT'
  quantity: string
  entryPrice: string
  exitPrice: string
  grossPnl: string
  fees: string
  netPnl: string
  feeKnown: boolean
}

export interface TradeStats {
  closedRoundTrips: ClosedRoundTrip[]
  closedCount: number
  winningCount: number
  winRate: string | null
  profitFactor: string | null
  expectancy: string | null
  maxDrawdown: string | null
  maxDrawdownPct: string | null
  totalFees: string
  feeCurrency?: string
  feeKnownOrders: number
  feeRelevantOrders: number
  slippage: string | null
  averageSlippage: string | null
  slippageCurrency?: string
  slippageTrackedOrders: number
  slippageUntrackedMarketOrders: number
}

interface Lot {
  side: 'BUY' | 'SELL'
  quantity: Decimal
  price: Decimal
  multiplier: Decimal
  orderId?: string
  fee?: Decimal
}

function contractKey(trade: TradeHistoryEntry): string {
  const c = trade.contract
  return c.aliceId ?? [c.exchange, c.localSymbol, c.symbol, c.secType, c.expiry, c.strike, c.right]
    .filter(Boolean).join('|')
}

function positiveDecimal(value: string | undefined): Decimal | undefined {
  if (value == null) return undefined
  try {
    const parsed = new Decimal(value)
    return parsed.isFinite() && parsed.gte(0) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** FIFO matcher. Input history may be newest-first; matching is always chronological. */
export function matchFifoRoundTrips(trades: TradeHistoryEntry[]): ClosedRoundTrip[] {
  const realTrades = trades
    .filter((trade) => trade.source !== 'reconcile')
    .map((trade, index) => ({ trade, index }))
    .sort((a, b) => a.trade.timestamp.localeCompare(b.trade.timestamp) || a.index - b.index)
  const queues = new Map<string, Lot[]>()
  const closed: ClosedRoundTrip[] = []

  for (const { trade } of realTrades) {
    let remaining = new Decimal(trade.quantity).abs()
    if (!remaining.isFinite() || remaining.isZero()) continue
    const key = contractKey(trade)
    const queue = queues.get(key) ?? []
    const price = new Decimal(trade.price)
    const multiplier = new Decimal(trade.contract.multiplier || '1')
    const totalFee = positiveDecimal(trade.fee)
    const originalQty = remaining

    while (!remaining.isZero() && queue.length > 0 && queue[0].side !== trade.side) {
      const open = queue[0]
      const matched = Decimal.min(open.quantity, remaining)
      const entryPrice = open.side === 'BUY' ? open.price : price
      const exitPrice = open.side === 'BUY' ? price : open.price
      const gross = exitPrice.minus(entryPrice).mul(matched).mul(open.multiplier)
      const openFee = open.fee?.mul(matched).div(open.quantity) ?? new Decimal(0)
      const closeFee = totalFee?.mul(matched).div(originalQty) ?? new Decimal(0)
      const fees = openFee.plus(closeFee)
      closed.push({
        contractKey: key,
        side: open.side === 'BUY' ? 'LONG' : 'SHORT',
        quantity: matched.toFixed(),
        entryPrice: entryPrice.toFixed(),
        exitPrice: exitPrice.toFixed(),
        grossPnl: gross.toFixed(),
        fees: fees.toFixed(),
        netPnl: gross.minus(fees).toFixed(),
        feeKnown: open.fee != null && totalFee != null,
      })
      open.quantity = open.quantity.minus(matched)
      if (open.fee) open.fee = open.fee.minus(openFee)
      remaining = remaining.minus(matched)
      if (open.quantity.isZero()) queue.shift()
    }

    if (!remaining.isZero()) {
      queue.push({
        side: trade.side,
        quantity: remaining,
        price,
        multiplier,
        orderId: trade.orderId,
        fee: totalFee?.mul(remaining).div(originalQty),
      })
    }
    queues.set(key, queue)
  }
  return closed
}

export function calculateMaxDrawdown(points: EquityCurvePoint[]): { amount: string; pct: string } | null {
  const ordered = [...points].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  let peak: Decimal | null = null
  let maximum = new Decimal(0)
  let maximumPct = new Decimal(0)
  for (const point of ordered) {
    const equity = new Decimal(point.equity)
    if (!equity.isFinite()) continue
    if (peak == null || equity.gt(peak)) peak = equity
    if (peak.lte(0)) continue
    const drawdown = peak.minus(equity)
    if (drawdown.gt(maximum)) {
      maximum = drawdown
      maximumPct = drawdown.div(peak).mul(100)
    }
  }
  return peak == null ? null : { amount: maximum.toFixed(), pct: maximumPct.toFixed() }
}

export function calculateTradeStats(
  trades: TradeHistoryEntry[],
  orders: OrderHistoryEntry[],
  equityCurve: EquityCurvePoint[],
): TradeStats {
  const closedRoundTrips = matchFifoRoundTrips(trades)
  const net = closedRoundTrips.map((roundTrip) => new Decimal(roundTrip.netPnl))
  const wins = net.filter((value) => value.gt(0))
  const losses = net.filter((value) => value.lt(0))
  const grossProfit = Decimal.sum(0, ...wins)
  const grossLoss = Decimal.sum(0, ...losses.map((value) => value.abs()))
  const feesByOrder = new Map(orders.filter((order) => order.orderId && positiveDecimal(order.fee) != null)
    .map((order) => [order.orderId!, positiveDecimal(order.fee)!]))
  const relevantOrderIds = new Set(trades
    .filter((trade) => trade.source !== 'reconcile' && trade.orderId)
    .map((trade) => trade.orderId!))
  const feeCurrencies = new Set(orders.filter((order) => order.feeCurrency).map((order) => order.feeCurrency!))
  const drawdown = calculateMaxDrawdown(equityCurve)

  let totalSlippage = new Decimal(0)
  let tracked = 0
  let untrackedMarket = 0
  const slippageCurrencies = new Set<string>()
  for (const order of orders) {
    if (order.status !== 'filled' || !order.avgFillPrice) continue
    if (!order.limitPrice) {
      if (order.orderType?.toUpperCase() === 'MKT') untrackedMarket++
      continue
    }
    const signed = new Decimal(order.avgFillPrice).minus(order.limitPrice)
      .mul(order.side === 'BUY' ? 1 : -1)
    totalSlippage = totalSlippage.plus(signed)
    tracked++
    if (order.contract.currency) slippageCurrencies.add(order.contract.currency)
  }

  return {
    closedRoundTrips,
    closedCount: closedRoundTrips.length,
    winningCount: wins.length,
    winRate: closedRoundTrips.length ? new Decimal(wins.length).div(closedRoundTrips.length).mul(100).toFixed() : null,
    profitFactor: grossLoss.isZero() ? (grossProfit.gt(0) ? 'Infinity' : null) : grossProfit.div(grossLoss).toFixed(),
    expectancy: net.length ? Decimal.sum(0, ...net).div(net.length).toFixed() : null,
    maxDrawdown: drawdown?.amount ?? null,
    maxDrawdownPct: drawdown?.pct ?? null,
    totalFees: Decimal.sum(0, ...feesByOrder.values()).toFixed(),
    ...(feeCurrencies.size === 1 && { feeCurrency: [...feeCurrencies][0] }),
    feeKnownOrders: [...relevantOrderIds].filter((id) => feesByOrder.has(id)).length,
    feeRelevantOrders: relevantOrderIds.size,
    slippage: tracked ? totalSlippage.toFixed() : null,
    averageSlippage: tracked ? totalSlippage.div(tracked).toFixed() : null,
    ...(slippageCurrencies.size === 1 && { slippageCurrency: [...slippageCurrencies][0] }),
    slippageTrackedOrders: tracked,
    slippageUntrackedMarketOrders: untrackedMarket,
  }
}
