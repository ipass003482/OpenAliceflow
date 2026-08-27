import Decimal from 'decimal.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { UNSET_DECIMAL } from '@traderalice/ibkr'
import type { Contract } from '@traderalice/ibkr'
import type { Operation } from '@traderalice/uta-protocol'
import type { IBroker } from './brokers/types.js'
import { dataPath } from '@/core/paths.js'

export interface AutoTradingRiskPolicy {
  enabled: boolean
  maxOrderNotional: number
  maxSymbolExposurePercent: number
  maxDailyLoss: number
  maxOrdersPerHour: number
  maxOrdersPerDay: number
  maxSlippageBps: number
  maxQuoteAgeMs: number
  allowedAliceIds: string[]
  pauseAfterConsecutiveErrors: number
}

export interface AutoTradingRiskStatus {
  paused: boolean
  pauseReason?: string
  consecutiveErrors: number
  ordersLastHour: number
  ordersToday: number
  day: string
}

interface PersistedState {
  day: string
  openingNetLiquidation?: string
  openingRealizedPnL?: string
  orderTimestamps: number[]
  consecutiveErrors: number
  paused?: boolean
  pauseReason?: string
}

const isFinitePositive = (value: Decimal): boolean => value.isFinite() && value.gt(0)

/** Mandatory envelope used only for AI-initiated pushes. It deliberately
 * fails closed: absent identity, quote, valuation, or policy state blocks a
 * new exposure rather than delegating the uncertainty to the broker. */
export class AutoTradingRiskController {
  private state: PersistedState

  constructor(
    private readonly accountId: string,
    private readonly broker: IBroker,
    private readonly policy: AutoTradingRiskPolicy,
  ) {
    this.state = { day: this.today(), orderTimestamps: [], consecutiveErrors: 0 }
  }

  private get path(): string {
    return dataPath('trading', this.accountId, 'automation-risk.json')
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<PersistedState>
      this.state = {
        day: typeof parsed.day === 'string' ? parsed.day : this.today(),
        openingNetLiquidation: typeof parsed.openingNetLiquidation === 'string' ? parsed.openingNetLiquidation : undefined,
        openingRealizedPnL: typeof parsed.openingRealizedPnL === 'string' ? parsed.openingRealizedPnL : undefined,
        orderTimestamps: Array.isArray(parsed.orderTimestamps) ? parsed.orderTimestamps.filter((n): n is number => typeof n === 'number') : [],
        consecutiveErrors: typeof parsed.consecutiveErrors === 'number' ? parsed.consecutiveErrors : 0,
        paused: parsed.paused === true,
        pauseReason: typeof parsed.pauseReason === 'string' ? parsed.pauseReason : undefined,
      }
    } catch { /* first automatic trade creates the state file */ }
    await this.rollDay()
  }

  status(): AutoTradingRiskStatus {
    const now = Date.now()
    return {
      paused: this.state.paused === true,
      pauseReason: this.state.pauseReason,
      consecutiveErrors: this.state.consecutiveErrors,
      ordersLastHour: this.state.orderTimestamps.filter((at) => at >= now - 3_600_000).length,
      ordersToday: this.state.orderTimestamps.length,
      day: this.state.day,
    }
  }

  async resetPause(): Promise<void> {
    this.state.paused = false
    this.state.pauseReason = undefined
    this.state.consecutiveErrors = 0
    await this.persist()
  }

  async pause(reason: string): Promise<void> {
    this.state.paused = true
    this.state.pauseReason = reason
    await this.persist()
  }

  async check(operation: Operation): Promise<void> {
    await this.rollDay()
    if (operation.action === 'cancelOrder' || operation.action === 'closePosition') return
    if (this.state.paused) throw new Error(`Automatic trading is paused: ${this.state.pauseReason ?? 'manual intervention required'}`)
    if (operation.action !== 'placeOrder') {
      throw new Error(`Automatic trading only permits new limit orders; ${operation.action} requires manual approval.`)
    }
    if (operation.order.orderType.toUpperCase() !== 'LMT') {
      throw new Error('Automatic trading only permits LMT orders; market and conditional orders require manual approval.')
    }
    const aliceId = operation.contract.aliceId
    if (!aliceId || !this.policy.allowedAliceIds.includes(aliceId)) {
      throw new Error(`Automatic trading denied: ${aliceId ?? 'missing aliceId'} is not in this account's allowed aliceId list.`)
    }

    const [account, positions, quote] = await Promise.all([
      this.broker.getAccount(),
      this.broker.getPositions(),
      this.broker.getQuote(operation.contract),
    ])
    const quoteAge = Date.now() - quote.timestamp.getTime()
    if (!Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > this.policy.maxQuoteAgeMs) {
      throw new Error(`Automatic trading denied: quote is ${Math.max(0, quoteAge)}ms old (limit ${this.policy.maxQuoteAgeMs}ms).`)
    }
    const reference = this.referencePrice(operation.order.action, quote)
    const limit = operation.order.lmtPrice
    if (!limit || limit.equals(UNSET_DECIMAL) || !isFinitePositive(limit)) {
      throw new Error('Automatic trading denied: LMT order is missing a valid limit price.')
    }
    const adverseBps = operation.order.action === 'BUY'
      ? limit.minus(reference).div(reference).mul(10_000)
      : reference.minus(limit).div(reference).mul(10_000)
    if (adverseBps.gt(this.policy.maxSlippageBps)) {
      throw new Error(`Automatic trading denied: limit price exceeds the ${this.policy.maxSlippageBps}bps slippage cap (${adverseBps.toFixed(1)}bps).`)
    }
    const quantity = operation.order.totalQuantity
    if (!quantity || quantity.equals(UNSET_DECIMAL) || !isFinitePositive(quantity)) {
      throw new Error('Automatic trading denied: a positive totalQuantity is required to calculate the risk envelope.')
    }
    const multiplier = this.multiplier(operation.contract)
    const orderNotional = quantity.mul(reference).mul(multiplier)
    if (orderNotional.gt(this.policy.maxOrderNotional)) {
      throw new Error(`Automatic trading denied: order notional ${orderNotional.toFixed(2)} exceeds ${this.policy.maxOrderNotional}.`)
    }
    const nativeKey = this.broker.getNativeKey(operation.contract)
    const positionValue = positions
      .filter((p) => this.broker.getNativeKey(p.contract) === nativeKey)
      .reduce((sum, p) => sum.plus(new Decimal(p.marketValue).abs()), new Decimal(0))
    const projectedExposure = positionValue.plus(orderNotional)
    const equity = new Decimal(account.netLiquidation)
    if (!isFinitePositive(equity)) throw new Error('Automatic trading denied: account equity is unavailable or invalid.')
    const exposurePercent = projectedExposure.div(equity).mul(100)
    if (exposurePercent.gt(this.policy.maxSymbolExposurePercent)) {
      throw new Error(`Automatic trading denied: projected ${operation.contract.symbol} exposure is ${exposurePercent.toFixed(2)}% (limit ${this.policy.maxSymbolExposurePercent}%).`)
    }
    this.ensureDailyLoss(account.netLiquidation, account.realizedPnL ?? '0')
    const now = Date.now()
    const hourly = this.state.orderTimestamps.filter((at) => at >= now - 3_600_000).length
    if (hourly >= this.policy.maxOrdersPerHour) throw new Error(`Automatic trading denied: hourly order limit (${this.policy.maxOrdersPerHour}) reached.`)
    if (this.state.orderTimestamps.length >= this.policy.maxOrdersPerDay) throw new Error(`Automatic trading denied: daily order limit (${this.policy.maxOrdersPerDay}) reached.`)
    // Reserve the slot before dispatch so concurrent/retried pushes cannot
    // overshoot the account-level rate limits. A venue rejection leaves a
    // conservative consumed slot, which is safer than a duplicate order.
    this.state.orderTimestamps.push(now)
    await this.persist()
  }

  async recordSuccess(operation: Operation): Promise<void> {
    if (operation.action !== 'placeOrder' && operation.action !== 'closePosition') return
    this.state.consecutiveErrors = 0
    await this.persist()
  }

  async recordFailure(error: unknown): Promise<void> {
    this.state.consecutiveErrors += 1
    if (this.state.consecutiveErrors >= this.policy.pauseAfterConsecutiveErrors) {
      this.state.paused = true
      this.state.pauseReason = `Circuit breaker: ${this.state.consecutiveErrors} consecutive broker errors (${error instanceof Error ? error.message : String(error)})`
    }
    await this.persist()
  }

  private referencePrice(action: string, quote: { bid: string; ask: string; last: string }): Decimal {
    const candidate = action === 'BUY' ? quote.ask : quote.bid
    const value = new Decimal(candidate || quote.last)
    if (!isFinitePositive(value)) throw new Error('Automatic trading denied: a valid bid/ask quote is required.')
    return value
  }

  private multiplier(contract: Contract): Decimal {
    const value = new Decimal(contract.multiplier || '1')
    if (!isFinitePositive(value)) throw new Error('Automatic trading denied: contract multiplier is invalid.')
    return value
  }

  private ensureDailyLoss(netLiquidation: string, realizedPnL: string): void {
    const openingEquity = new Decimal(this.state.openingNetLiquidation ?? netLiquidation)
    const openingRealized = new Decimal(this.state.openingRealizedPnL ?? realizedPnL)
    this.state.openingNetLiquidation ??= openingEquity.toString()
    this.state.openingRealizedPnL ??= openingRealized.toString()
    const equityLoss = Decimal.max(openingEquity.minus(netLiquidation), 0)
    const realizedLoss = Decimal.max(openingRealized.minus(realizedPnL), 0)
    const loss = Decimal.max(equityLoss, realizedLoss)
    if (loss.gt(this.policy.maxDailyLoss)) {
      throw new Error(`Automatic trading denied: daily loss ${loss.toFixed(2)} exceeds ${this.policy.maxDailyLoss}.`)
    }
  }

  private today(): string { return new Date().toISOString().slice(0, 10) }

  private async rollDay(): Promise<void> {
    const day = this.today()
    if (this.state.day !== day) {
      this.state = { day, orderTimestamps: [], consecutiveErrors: 0, paused: this.state.paused, pauseReason: this.state.pauseReason }
      await this.persist()
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify(this.state, null, 2))
  }
}
