/**
 * FutuBroker — read-only IBroker adapter for Futu (富途) via FutuOpenD.
 *
 * Increment 1 scope (see plans/uta-broker-futu.md): account funds, positions,
 * snapshot quotes, market clock, static-info contract details, and native-key
 * round-trip. Every order-write method loud-refuses — no placement, modify,
 * cancel, or close is implemented, so this engine can never submit an order.
 *
 * Transport: the `futu-api` SDK talks WebSocket to a locally running,
 * separately installed and logged-in FutuOpenD gateway process. Credentials
 * live in FutuOpenD itself; this adapter only needs host/port (+ optional
 * connection key) and which trade env/market/account to read.
 *
 * NOT verified against a live FutuOpenD gateway — no gateway or Futu account
 * is available in this development environment. Mappings follow the bundled
 * `.proto` sources; unit tests exercise them against mocked gateway payloads.
 */

import { z } from 'zod'
import Decimal from 'decimal.js'
import { createHash } from 'node:crypto'
import { Contract, ContractDescription, ContractDetails, Order, OrderState, UNSET_DECIMAL } from '@traderalice/ibkr'
import {
  BrokerError,
  type IBroker,
  type AccountCapabilities,
  type AccountInfo,
  type Position,
  type PlaceOrderResult,
  type OpenOrder,
  type Quote,
  type MarketClock,
  type TpSlParams,
  type BrokerConnectionStateEvent,
} from '../types.js'
import '../../contract-ext.js'
import { buildPosition } from '../contract-builder.js'
import {
  currencyForPrefix,
  echoContractDescription,
  keyToSecurity,
  makeContract,
  resolveFutuKey,
  trdSecMarketToPrefix,
} from './futu-contracts.js'
import {
  FUTU_CURRENCY_CODES,
  FUTU_OPEN_MARKET_STATES,
  FutuModifyOrderOp,
  FutuOrderStatus,
  FutuOrderType,
  FutuPositionSide,
  FutuTrdEnv,
  FutuTrdMarket,
  FutuTrdSide,
  type FutuConnectionEvent,
  type FutuGateway,
  type FutuGatewayFactory,
  type FutuGlobalStateLike,
  type FutuOrderLike,
  type FutuTrdHeader,
} from './futu-types.js'

/** IBKR-style Order.action → Trd_Common.TrdSide. Client only ever sends Buy/Sell (see Trd_Common.proto's own comment on TrdSide). */
const FUTU_SIDE_BY_ACTION: Record<string, number> = { BUY: FutuTrdSide.Buy, SELL: FutuTrdSide.Sell }

/** Trd_Common.TrdSide → IBKR-style Order.action, for order tracking (getOrders/getOrder). */
const ACTION_BY_FUTU_SIDE: Record<number, string> = {
  [FutuTrdSide.Buy]: 'BUY', [FutuTrdSide.Sell]: 'SELL',
  [FutuTrdSide.SellShort]: 'SELL', [FutuTrdSide.BuyBack]: 'BUY',
}

/**
 * IBKR-style Order.orderType → Trd_Common.OrderType. Deliberately narrow:
 * TWAP/VWAP, combo, and event-contract order types are out of scope for
 * this increment (see plans/uta-broker-futu.md Increment 2).
 */
const FUTU_ORDER_TYPE_BY_IBKR: Record<string, number> = {
  MKT: FutuOrderType.Market,
  LMT: FutuOrderType.Normal,
  STP: FutuOrderType.Stop,
  'STP LMT': FutuOrderType.StopLimit,
}

/** Trd_Common.OrderType → IBKR-style Order.orderType, for order tracking. */
const IBKR_ORDER_TYPE_BY_FUTU: Record<number, string> = {
  [FutuOrderType.Market]: 'MKT',
  [FutuOrderType.Normal]: 'LMT',
  [FutuOrderType.Stop]: 'STP',
  [FutuOrderType.StopLimit]: 'STP LMT',
  [FutuOrderType.MarketIfTouched]: 'MIT',
  [FutuOrderType.LimitIfTouched]: 'LIT',
  [FutuOrderType.TrailingStop]: 'TRAIL',
  [FutuOrderType.TrailingStopLimit]: 'TRAIL LIMIT',
}

/**
 * Trd_Common.OrderStatus → IBKR-style OrderState.status vocabulary — same
 * convention AlpacaBroker's mapAlpacaOrderStatus uses (alpaca-contracts.ts),
 * so the ledger/sync layer sees one consistent status vocabulary regardless
 * of broker.
 */
const IBKR_STATUS_BY_FUTU: Record<number, string> = {
  [FutuOrderStatus.Unsubmitted]: 'PendingSubmit',
  [FutuOrderStatus.WaitingSubmit]: 'PendingSubmit',
  [FutuOrderStatus.Submitting]: 'PreSubmitted',
  [FutuOrderStatus.SubmitFailed]: 'ApiCancelled',
  [FutuOrderStatus.TimeOut]: 'PreSubmitted',
  [FutuOrderStatus.Submitted]: 'Submitted',
  [FutuOrderStatus.FilledPart]: 'Submitted',
  [FutuOrderStatus.FilledAll]: 'Filled',
  [FutuOrderStatus.CancellingPart]: 'PendingCancel',
  [FutuOrderStatus.CancellingAll]: 'PendingCancel',
  [FutuOrderStatus.CancelledPart]: 'Cancelled',
  [FutuOrderStatus.CancelledAll]: 'Cancelled',
  [FutuOrderStatus.Failed]: 'ApiCancelled',
  [FutuOrderStatus.Disabled]: 'Inactive',
  [FutuOrderStatus.Deleted]: 'Cancelled',
  [FutuOrderStatus.FillCancelled]: 'Cancelled',
}

/** Config trdMarket label → Trd_Common.TrdMarket enum. */
const TRD_MARKET_BY_LABEL: Record<string, number> = {
  HK: FutuTrdMarket.HK,
  US: FutuTrdMarket.US,
  CN: FutuTrdMarket.CN,
  SG: FutuTrdMarket.SG,
  JP: FutuTrdMarket.JP,
}

/** Fallback AccountInfo currency per configured trade market. */
const BASE_CURRENCY_BY_MARKET: Record<string, string> = {
  HK: 'HKD', US: 'USD', CN: 'CNH', SG: 'SGD', JP: 'JPY',
}

/**
 * How far back getOrders/getOrder searches Trd_GetHistoryOrderList when an
 * order id is not in today's Trd_GetOrderList (e.g. an overnight GTC order).
 * One month, per the maintainer's explicit request.
 */
const ORDER_HISTORY_LOOKBACK_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * `YYYY-MM-DD HH:MM:SS` — the strict format TrdFilterConditions requires.
 * Uses local machine time: the proto does not document a timezone, and
 * FutuOpenD runs on the same machine, so local time is the sane default.
 */
function futuTimeString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Default factory — loads the real WebSocket gateway lazily so unit tests
 *  that inject a fake never evaluate the `futu-api` SDK. */
const defaultGatewayFactory: FutuGatewayFactory = async (config) => {
  const { FutuGatewayClient } = await import('./FutuGatewayClient.js')
  return new FutuGatewayClient(config)
}

/**
 * Live basic-quote push shape (see `FutuBroker.subscribeQuote`). Deliberately
 * NOT `Quote` — no bid/ask, since `Qot_UpdateBasicQot` doesn't carry them.
 */
export interface FutuBasicQuoteUpdate {
  contract: Contract
  last: string
  high: string
  low: string
  open: string
  lastClose: string
  volume: string
  turnover: string
  timestamp: Date
}

export class FutuBroker implements IBroker {
  // ---- Self-registration ----

  static configSchema = z.object({
    /** FutuOpenD gateway address. The gateway runs on the user's machine. */
    host: z.string().default('127.0.0.1'),
    /** FutuOpenD `websocket_port` (its shipped default configuration uses 33333). */
    port: z.number().int().default(33333),
    ssl: z.boolean().default(false),
    /** FutuOpenD `websocket_key` when one is configured. */
    wsKey: z.string().optional(),
    /** Trade environment: simulate (paper) or real. Defaults to simulate. */
    trdEnv: z.enum(['simulate', 'real']).default('simulate'),
    /** Trade market the TrdHeader scopes to. */
    trdMarket: z.enum(['HK', 'US', 'CN', 'SG', 'JP']).default('HK'),
    /** Explicit business account id; omitted ⇒ first account matching env+market. */
    accID: z.string().optional(),
    /**
     * Trade unlock password (Trd_UnlockTrade's pwdMD5, plaintext here — this
     * adapter hashes it locally before it ever reaches the wire). Optional:
     * leave blank to unlock manually inside FutuOpenD/moomoo yourself each
     * session instead of storing it here. Never persisted in git — this is
     * runtime broker config, same storage as any other broker's API secret.
     */
    tradePassword: z.string().optional(),
  })

  static fromConfig(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }): FutuBroker {
    const bc = FutuBroker.configSchema.parse(config.brokerConfig)
    return new FutuBroker({ id: config.id, label: config.label, ...bc })
  }

  // ---- Instance ----

  readonly brokerEngine = 'futu'
  readonly id: string
  readonly label: string
  private readonly cfg: z.infer<typeof FutuBroker.configSchema> & { id?: string; label?: string }
  private readonly gatewayFactory: FutuGatewayFactory
  private gateway!: FutuGateway
  private header!: FutuTrdHeader
  /**
   * Push-fresh order rows keyed by String(orderID), fed by Trd_UpdateOrder
   * pushes. A cache hit means "the last thing FutuOpenD told us about this
   * order" — cleared on any transport interruption, because pushes missed
   * while disconnected would otherwise leave silently stale entries.
   */
  private readonly orderCache = new Map<string, FutuOrderLike>()
  private connectionListener: ((event: BrokerConnectionStateEvent) => void) | null = null

  constructor(cfg: z.infer<typeof FutuBroker.configSchema> & { id?: string; label?: string }, gatewayFactory?: FutuGatewayFactory) {
    this.cfg = cfg
    this.id = cfg.id ?? (cfg.trdEnv === 'simulate' ? 'futu-simulate' : 'futu-live')
    this.label = cfg.label ?? (cfg.trdEnv === 'simulate' ? 'Futu Simulate' : 'Futu')
    this.gatewayFactory = gatewayFactory ?? defaultGatewayFactory
  }

  // ---- Lifecycle ----

  async init(): Promise<void> {
    // The recovery loop re-runs init() without calling close() first. Stop
    // any previous gateway so its SDK-internal auto-reconnect loop can't
    // keep a zombie connection (and its push subscriptions) alive.
    this.gateway?.setConnectionListener(null)
    this.gateway?.stop()
    this.orderCache.clear()

    try {
      this.gateway = await this.gatewayFactory({ host: this.cfg.host, port: this.cfg.port, ssl: this.cfg.ssl, wsKey: this.cfg.wsKey })
      await this.gateway.connect()
    } catch (err) {
      throw new BrokerError('NETWORK', `Cannot connect to FutuOpenD at ${this.cfg.host}:${this.cfg.port} — is the gateway running and logged in? ${err instanceof Error ? err.message : String(err)}`)
    }
    this.gateway.setConnectionListener((event) => this.handleGatewayConnectionEvent(event))

    const state = await this.gateway.getGlobalState()
    if (!state.trdLogined) {
      throw new BrokerError('AUTH', 'FutuOpenD is reachable but not logged in to the trade server — log in inside FutuOpenD first')
    }

    const wantEnv = this.cfg.trdEnv === 'simulate' ? FutuTrdEnv.Simulate : FutuTrdEnv.Real
    const wantMarket = TRD_MARKET_BY_LABEL[this.cfg.trdMarket]
    const accounts = await this.gateway.getAccList()
    const candidates = accounts.filter((a) => a.trdEnv === wantEnv && (a.trdMarketAuthList ?? []).includes(wantMarket))
    const chosen = this.cfg.accID ? candidates.find((a) => String(a.accID) === this.cfg.accID) : candidates[0]
    if (!chosen) {
      throw new BrokerError('CONFIG', `No Futu ${this.cfg.trdEnv} account with ${this.cfg.trdMarket} market access${this.cfg.accID ? ` and accID ${this.cfg.accID}` : ''} — check FutuOpenD login and config`)
    }
    this.header = { trdEnv: wantEnv, accID: String(chosen.accID), trdMarket: wantMarket }

    await this.unlockIfConfigured()

    // Order-update push (Trd_SubAccPush → Trd_UpdateOrder) keeps the order
    // cache fresh without polling. Non-fatal: the getOrderList/history
    // polling paths still work without it.
    try {
      await this.gateway.subscribeOrderUpdates(this.header.accID, (order) => {
        this.orderCache.set(String(order.orderID), order)
      })
    } catch (err) {
      console.warn(`FutuBroker[${this.id}]: order-update push subscription failed — order tracking falls back to polling: ${err instanceof Error ? err.message : String(err)}`)
    }

    console.log(`FutuBroker[${this.id}]: connected (env=${this.cfg.trdEnv}, market=${this.cfg.trdMarket}, accID=${this.header.accID})`)
  }

  private async unlockIfConfigured(): Promise<void> {
    if (!this.cfg.tradePassword) return
    try {
      const pwdMD5 = createHash('md5').update(this.cfg.tradePassword).digest('hex')
      await this.gateway.unlockTrade(pwdMD5)
      console.log(`FutuBroker[${this.id}]: trade unlocked`)
    } catch (err) {
      // Non-fatal: reads (quotes/positions/funds) don't need trade unlock.
      // If unlock genuinely failed (wrong password), it resurfaces the
      // moment an order write is attempted — FutuOpenD itself rejects it.
      console.warn(`FutuBroker[${this.id}]: trade unlock failed — order writes will fail until this is resolved: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private handleGatewayConnectionEvent(event: FutuConnectionEvent): void {
    // Pushes were interrupted either way — cached order rows may be stale.
    this.orderCache.clear()
    if (event.state === 'restored') {
      // The SDK reconnected to an OpenD at the same address. If OpenD itself
      // restarted, its unlock state is gone — re-unlock is idempotent and
      // cheap, so always re-run it rather than guessing.
      void this.unlockIfConfigured()
      this.connectionListener?.({ state: 'restored' })
      return
    }
    this.connectionListener?.({ state: 'dead', error: event.error })
  }

  setConnectionStateListener(listener: ((event: BrokerConnectionStateEvent) => void) | null): void {
    this.connectionListener = listener
  }

  async close(): Promise<void> {
    this.gateway?.setConnectionListener(null)
    this.gateway?.stop()
    this.orderCache.clear()
  }

  // ---- Contract search (SearchingCatalog model — echo + static-info) ----

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    if (!pattern) return []
    // Futu's GetStaticInfo requires exact market+code pairs; there is no
    // fuzzy-name search on this read path. Echo the pattern as a contract
    // guess (market-prefixed if the user supplied one, defaulted to US).
    return [echoContractDescription(pattern)]
  }

  async getContractDetails(query: Contract): Promise<ContractDetails | null> {
    const key = resolveFutuKey(query)
    if (!key) return null
    try {
      const infos = await this.gateway.getStaticInfo([keyToSecurity(key)])
      if (!infos.length) return null
      const basic = infos[0].basic
      const details = new ContractDetails()
      details.contract = makeContract(key)
      if (basic.name) details.contract.description = basic.name
      details.minSize = new Decimal(basic.lotSize || 1)
      details.orderTypes = 'MKT,LMT,STP,STP LMT'
      details.stockType = 'COMMON'
      return details
    } catch {
      // Unknown to Futu (wrong market prefix / delisted) — null per IBroker contract.
      return null
    }
  }

  // ---- Trading operations ----
  //
  // Scope (Increment 2, see plans/uta-broker-futu.md): single-leg equity
  // orders only — MKT/LMT/STP/STP LMT via Trd_PlaceOrder + Trd_ModifyOrder.
  // Combo orders, TWAP/VWAP, and bracket TP/SL legs are explicitly refused
  // rather than silently dropped or approximated.
  //
  // NOT verified against a live FutuOpenD gateway or a real Futu account —
  // same unverified ceiling as every other Futu increment in this codebase.
  // Start on `trdEnv: 'simulate'` and confirm behavior there first.

  async placeOrder(contract: Contract, order: Order, tpsl?: TpSlParams): Promise<PlaceOrderResult> {
    if (tpsl?.takeProfit || tpsl?.stopLoss) {
      return { success: false, error: 'Futu adapter does not support bracket take-profit/stop-loss legs yet — place the protective order as a separate order.' }
    }
    const key = resolveFutuKey(contract)
    if (!key) return { success: false, error: 'Cannot resolve contract to a Futu market/code key' }
    const trdSide = FUTU_SIDE_BY_ACTION[order.action]
    if (trdSide === undefined) return { success: false, error: `Unsupported order action for Futu: ${order.action || '(empty)'}` }
    const orderType = FUTU_ORDER_TYPE_BY_IBKR[order.orderType]
    if (orderType === undefined) return { success: false, error: `Unsupported order type for Futu: ${order.orderType || '(empty)'} (supported: MKT, LMT, STP, STP LMT)` }
    if (order.totalQuantity.equals(UNSET_DECIMAL) || order.totalQuantity.lte(0)) {
      return { success: false, error: 'Invalid or missing order quantity' }
    }
    const needsPrice = orderType === FutuOrderType.Normal || orderType === FutuOrderType.StopLimit
    const needsAux = orderType === FutuOrderType.Stop || orderType === FutuOrderType.StopLimit
    if (needsPrice && order.lmtPrice.equals(UNSET_DECIMAL)) {
      return { success: false, error: 'Limit price is required for this order type' }
    }
    if (needsAux && order.auxPrice.equals(UNSET_DECIMAL)) {
      return { success: false, error: 'Trigger (aux) price is required for this order type' }
    }
    const security = keyToSecurity(key)
    try {
      const result = await this.gateway.placeOrder({
        header: this.header,
        trdSide,
        orderType,
        code: security.code,
        qty: order.totalQuantity.toNumber(),
        price: needsPrice ? order.lmtPrice.toNumber() : undefined,
        auxPrice: needsAux ? order.auxPrice.toNumber() : undefined,
      })
      return { success: true, orderId: String(result.orderID) }
    } catch (err) {
      return { success: false, error: BrokerError.from(err).message }
    }
  }

  async modifyOrder(orderId: string, changes: Partial<Order>): Promise<PlaceOrderResult> {
    const qty = changes.totalQuantity != null && !changes.totalQuantity.equals(UNSET_DECIMAL) ? changes.totalQuantity.toNumber() : undefined
    const price = changes.lmtPrice != null && !changes.lmtPrice.equals(UNSET_DECIMAL) ? changes.lmtPrice.toNumber() : undefined
    const auxPrice = changes.auxPrice != null && !changes.auxPrice.equals(UNSET_DECIMAL) ? changes.auxPrice.toNumber() : undefined
    if (qty === undefined && price === undefined && auxPrice === undefined) {
      return { success: false, error: 'No modifiable fields provided (only qty/lmtPrice/auxPrice are supported)' }
    }
    try {
      const result = await this.gateway.modifyOrder({
        header: this.header,
        orderID: orderId,
        modifyOrderOp: FutuModifyOrderOp.Normal,
        qty,
        price,
        auxPrice,
      })
      return { success: true, orderId: String(result.orderID) }
    } catch (err) {
      return { success: false, error: BrokerError.from(err).message }
    }
  }

  async cancelOrder(orderId: string): Promise<PlaceOrderResult> {
    try {
      const result = await this.gateway.modifyOrder({
        header: this.header,
        orderID: orderId,
        modifyOrderOp: FutuModifyOrderOp.Cancel,
      })
      const orderState = new OrderState()
      orderState.status = 'Cancelled'
      return { success: true, orderId: String(result.orderID), orderState }
    } catch (err) {
      return { success: false, error: BrokerError.from(err).message }
    }
  }

  async closePosition(contract: Contract, quantity?: Decimal): Promise<PlaceOrderResult> {
    const key = resolveFutuKey(contract)
    if (!key) return { success: false, error: 'Cannot resolve contract to a Futu market/code key' }
    const positions = await this.getPositions()
    const match = positions.find((p) => this.getNativeKey(p.contract) === key)
    if (!match) return { success: false, error: `No open position for ${key}` }
    const closeQty = quantity != null && quantity.gt(0) ? Decimal.min(quantity, match.quantity) : match.quantity
    if (closeQty.lte(0)) return { success: false, error: 'Nothing to close' }
    const order = new Order()
    order.action = match.side === 'long' ? 'SELL' : 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = closeQty
    return this.placeOrder(contract, order)
  }

  // ---- Queries ----

  async getAccount(): Promise<AccountInfo> {
    let funds
    try {
      funds = await this.gateway.getFunds(this.header)
    } catch (err) {
      throw BrokerError.from(err)
    }
    const fallbackCurrency = BASE_CURRENCY_BY_MARKET[this.cfg.trdMarket] ?? 'HKD'
    if (!funds) {
      return { baseCurrency: fallbackCurrency, netLiquidation: '0', totalCashValue: '0', unrealizedPnL: '0' }
    }
    const info: AccountInfo = {
      baseCurrency: (funds.currency !== undefined ? FUTU_CURRENCY_CODES[funds.currency] : undefined) ?? fallbackCurrency,
      netLiquidation: dec(funds.totalAssets),
      totalCashValue: dec(funds.cash),
      unrealizedPnL: dec(funds.unrealizedPL ?? 0),
      buyingPower: dec(funds.power),
    }
    if (funds.realizedPL !== undefined) info.realizedPnL = dec(funds.realizedPL)
    if (funds.initialMargin !== undefined) info.initMarginReq = dec(funds.initialMargin)
    if (funds.maintenanceMargin !== undefined) info.maintMarginReq = dec(funds.maintenanceMargin)
    return info
  }

  async getPositions(): Promise<Position[]> {
    let rows
    try {
      rows = await this.gateway.getPositionList(this.header)
    } catch (err) {
      throw BrokerError.from(err)
    }
    const out: Position[] = []
    for (const p of rows) {
      const qty = new Decimal(p.qty ?? 0)
      if (qty.isZero()) continue
      const prefix = trdSecMarketToPrefix(p.secMarket)
      const contract = makeContract(`${prefix}.${p.code}`)
      if (p.name) contract.description = p.name
      const avgCost = dec(p.averageCostPrice ?? p.dilutedCostPrice ?? p.costPrice ?? 0)
      const currency = (p.currency !== undefined ? FUTU_CURRENCY_CODES[p.currency] : undefined) ?? currencyForPrefix(prefix)
      const hasBrokerValues = p.val !== undefined && p.val !== 0
      out.push(buildPosition({
        contract,
        currency,
        side: p.positionSide === FutuPositionSide.Short ? 'short' : 'long',
        quantity: qty.abs(),
        avgCost,
        marketPrice: dec(p.price ?? 0),
        realizedPnL: dec(p.realizedPL ?? 0),
        multiplier: '1',
        // Securities rows carry broker-computed 市值/盈亏; futures rows report
        // val=0 (per Trd_Common.proto) — those fall through to derived math.
        ...(hasBrokerValues ? { marketValue: dec(p.val), unrealizedPnL: dec(p.plVal ?? 0) } : {}),
      }))
    }
    return out
  }

  async getOrders(orderIds: string[]): Promise<OpenOrder[]> {
    const rows = await this.lookupOrders(orderIds)
    return rows.map((o) => this.toOpenOrder(o))
  }

  async getOrder(orderId: string, _symbolHint?: string): Promise<OpenOrder | null> {
    const rows = await this.lookupOrders([orderId])
    return rows.length ? this.toOpenOrder(rows[0]) : null
  }

  /**
   * Resolve order ids through three tiers, stopping as soon as every id is
   * found: (1) the push-fresh order cache, (2) today's Trd_GetOrderList,
   * (3) Trd_GetHistoryOrderList over the past ORDER_HISTORY_LOOKBACK_DAYS.
   * Tier 3 exists because Trd_GetOrderList only covers TODAY — without it an
   * overnight GTC order becomes untrackable the morning after placement.
   * Unresolved ids are dropped (same contract as AlpacaBroker.getOrders).
   */
  private async lookupOrders(orderIds: string[]): Promise<FutuOrderLike[]> {
    const found = new Map<string, FutuOrderLike>()
    const missing = new Set<string>()
    for (const id of orderIds) {
      const hit = this.orderCache.get(id)
      if (hit) found.set(id, hit)
      else missing.add(id)
    }

    if (missing.size > 0) {
      let today: FutuOrderLike[]
      try {
        today = await this.gateway.getOrderList(this.header)
      } catch (err) {
        throw BrokerError.from(err)
      }
      for (const o of today) {
        const id = String(o.orderID)
        if (missing.delete(id)) found.set(id, o)
      }
    }

    if (missing.size > 0) {
      const now = Date.now()
      let history: FutuOrderLike[]
      try {
        history = await this.gateway.getHistoryOrderList(this.header, {
          beginTime: futuTimeString(new Date(now - ORDER_HISTORY_LOOKBACK_DAYS * DAY_MS)),
          // One day of forward slack absorbs OpenD/server clock skew.
          endTime: futuTimeString(new Date(now + DAY_MS)),
          idList: [...missing],
        })
      } catch (err) {
        throw BrokerError.from(err)
      }
      for (const o of history) {
        const id = String(o.orderID)
        if (missing.delete(id)) found.set(id, o)
      }
    }

    return orderIds
      .map((id) => found.get(id))
      .filter((o): o is FutuOrderLike => o !== undefined)
  }

  /** Trd_Common.Order → OpenOrder (IBKR-shaped Order + OrderState), for getOrders/getOrder. */
  private toOpenOrder(o: FutuOrderLike): OpenOrder {
    const prefix = trdSecMarketToPrefix(o.secMarket)
    const contract = makeContract(`${prefix}.${o.code}`)
    if (o.name) contract.description = o.name

    const order = new Order()
    order.action = ACTION_BY_FUTU_SIDE[o.trdSide] ?? 'BUY'
    order.totalQuantity = new Decimal(o.qty)
    order.orderType = IBKR_ORDER_TYPE_BY_FUTU[o.orderType] ?? 'LMT'
    if (o.price !== undefined) order.lmtPrice = new Decimal(o.price)
    if (o.auxPrice !== undefined) order.auxPrice = new Decimal(o.auxPrice)
    if (o.fillQty !== undefined) order.filledQuantity = new Decimal(o.fillQty)
    // Futu orderID is uint64 — IBKR's orderId field is a number and would
    // lose precision. Leave at default 0 (same precedent as AlpacaBroker's
    // UUID ids); the real id lives in OpenOrder.orderId below.
    order.orderId = 0

    const orderState = new OrderState()
    orderState.status = IBKR_STATUS_BY_FUTU[o.orderStatus] ?? 'Submitted'
    if (o.lastErrMsg) orderState.rejectReason = o.lastErrMsg

    return {
      contract,
      order,
      orderState,
      orderId: String(o.orderID),
      ...(o.fillAvgPrice !== undefined && { avgFillPrice: dec(o.fillAvgPrice) }),
    }
  }

  async getQuote(contract: Contract): Promise<Quote> {
    const key = resolveFutuKey(contract)
    if (!key) throw new BrokerError('EXCHANGE', 'Cannot resolve contract to a Futu market/code key')
    let snapshots
    try {
      snapshots = await this.gateway.getSecuritySnapshot([keyToSecurity(key)])
    } catch (err) {
      throw BrokerError.from(err)
    }
    if (!snapshots.length) throw new BrokerError('EXCHANGE', `No snapshot for ${key}`)
    const b = snapshots[0].basic
    return {
      contract: makeContract(key),
      last: dec(b.curPrice),
      bid: b.bidPrice !== undefined ? dec(b.bidPrice) : '0',
      ask: b.askPrice !== undefined ? dec(b.askPrice) : '0',
      volume: new Decimal(String(b.volume ?? 0)).toString(),
      high: dec(b.highPrice),
      low: dec(b.lowPrice),
      // updateTimestamp is epoch seconds (proto: 更新时间戳).
      timestamp: b.updateTimestamp ? new Date(b.updateTimestamp * 1000) : new Date(),
    }
  }

  /**
   * Live basic-quote push (Qot_Sub SubType_Basic → Qot_UpdateBasicQot).
   *
   * Fulfills `IBroker.subscribeQuote?` (see plans/futu-realtime-quotes.md).
   * Deliberately returns a distinct `FutuBasicQuoteUpdate` shape rather than
   * `Quote`: the underlying `BasicQot` push message carries no bid/ask (that
   * lives behind the separate order-book subscription, out of scope here),
   * so forcing it into `Quote`'s required bid/ask fields would fabricate
   * data that was never actually pushed.
   */
  async subscribeQuote(
    contract: Contract,
    onUpdate: (update: FutuBasicQuoteUpdate) => void,
  ): Promise<() => Promise<void>> {
    const key = resolveFutuKey(contract)
    if (!key) throw new BrokerError('EXCHANGE', 'Cannot resolve contract to a Futu market/code key')
    try {
      return await this.gateway.subscribeBasicQuote([keyToSecurity(key)], (rows) => {
        for (const b of rows) {
          onUpdate({
            contract: makeContract(key),
            last: dec(b.curPrice),
            high: dec(b.highPrice),
            low: dec(b.lowPrice),
            open: dec(b.openPrice),
            lastClose: dec(b.lastClosePrice),
            volume: new Decimal(String(b.volume ?? 0)).toString(),
            turnover: dec(b.turnover),
            timestamp: b.updateTimestamp ? new Date(b.updateTimestamp * 1000) : new Date(),
          })
        }
      })
    } catch (err) {
      throw BrokerError.from(err)
    }
  }

  async getMarketClock(): Promise<MarketClock> {
    let state: FutuGlobalStateLike
    try {
      state = await this.gateway.getGlobalState()
    } catch (err) {
      throw BrokerError.from(err)
    }
    const marketState = this.marketStateFor(state)
    return { isOpen: marketState !== undefined && FUTU_OPEN_MARKET_STATES.has(marketState), timestamp: new Date() }
  }

  private marketStateFor(state: FutuGlobalStateLike): number | undefined {
    switch (this.cfg.trdMarket) {
      case 'HK': return state.marketHK
      // SH proxies the CN session; SZ shares the same trading hours.
      case 'CN': return state.marketSH
      case 'US': return state.marketUS
      case 'SG': return state.marketSG
      case 'JP': return state.marketJP
      default: return undefined
    }
  }

  // ---- Capabilities ----

  getCapabilities(): AccountCapabilities {
    return { supportedSecTypes: ['STK'], supportedOrderTypes: ['MKT', 'LMT', 'STP', 'STP LMT'] }
  }

  // ---- Contract identity ----

  getNativeKey(contract: Contract): string {
    const key = resolveFutuKey(contract)
    return key ?? contract.symbol ?? ''
  }

  resolveNativeKey(nativeKey: string): Contract {
    return makeContract(nativeKey)
  }
}

/** Double → Decimal string (guards non-finite doubles to '0'). */
function dec(value: number): string {
  return Number.isFinite(value) ? new Decimal(value).toString() : '0'
}
