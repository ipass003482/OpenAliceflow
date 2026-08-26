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
import { Contract, ContractDescription, ContractDetails, Order } from '@traderalice/ibkr'
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
  FutuPositionSide,
  FutuTrdEnv,
  FutuTrdMarket,
  type FutuGateway,
  type FutuGatewayFactory,
  type FutuGlobalStateLike,
  type FutuTrdHeader,
} from './futu-types.js'

const READ_ONLY_REFUSAL = 'Futu order writes are not implemented — this adapter is read-only (Increment 1, see plans/uta-broker-futu.md)'

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

/** Default factory — loads the real WebSocket gateway lazily so unit tests
 *  that inject a fake never evaluate the `futu-api` SDK. */
const defaultGatewayFactory: FutuGatewayFactory = async (config) => {
  const { FutuGatewayClient } = await import('./FutuGatewayClient.js')
  return new FutuGatewayClient(config)
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

  constructor(cfg: z.infer<typeof FutuBroker.configSchema> & { id?: string; label?: string }, gatewayFactory?: FutuGatewayFactory) {
    this.cfg = cfg
    this.id = cfg.id ?? (cfg.trdEnv === 'simulate' ? 'futu-simulate' : 'futu-live')
    this.label = cfg.label ?? (cfg.trdEnv === 'simulate' ? 'Futu Simulate' : 'Futu')
    this.gatewayFactory = gatewayFactory ?? defaultGatewayFactory
  }

  // ---- Lifecycle ----

  async init(): Promise<void> {
    try {
      this.gateway = await this.gatewayFactory({ host: this.cfg.host, port: this.cfg.port, ssl: this.cfg.ssl, wsKey: this.cfg.wsKey })
      await this.gateway.connect()
    } catch (err) {
      throw new BrokerError('NETWORK', `Cannot connect to FutuOpenD at ${this.cfg.host}:${this.cfg.port} — is the gateway running and logged in? ${err instanceof Error ? err.message : String(err)}`)
    }

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
    console.log(`FutuBroker[${this.id}]: connected (env=${this.cfg.trdEnv}, market=${this.cfg.trdMarket}, accID=${this.header.accID})`)
  }

  async close(): Promise<void> {
    this.gateway?.stop()
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
      details.orderTypes = ''
      details.stockType = 'COMMON'
      return details
    } catch {
      // Unknown to Futu (wrong market prefix / delisted) — null per IBroker contract.
      return null
    }
  }

  // ---- Trading operations (read-only: loud-refuse) ----

  async placeOrder(_contract: Contract, _order: Order, _tpsl?: TpSlParams): Promise<PlaceOrderResult> {
    return { success: false, error: READ_ONLY_REFUSAL }
  }

  async modifyOrder(_orderId: string, _changes: Partial<Order>): Promise<PlaceOrderResult> {
    return { success: false, error: READ_ONLY_REFUSAL }
  }

  async cancelOrder(_orderId: string): Promise<PlaceOrderResult> {
    return { success: false, error: READ_ONLY_REFUSAL }
  }

  async closePosition(_contract: Contract, _quantity?: Decimal): Promise<PlaceOrderResult> {
    return { success: false, error: READ_ONLY_REFUSAL }
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

  async getOrders(_orderIds: string[]): Promise<OpenOrder[]> {
    // Read-only increment: no orders can have been placed through this
    // adapter, so there are no tracked ids to resolve.
    return []
  }

  async getOrder(_orderId: string, _symbolHint?: string): Promise<OpenOrder | null> {
    // Read-only increment — see getOrders.
    return null
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
    // Empty supportedOrderTypes states the read-only contract explicitly.
    return { supportedSecTypes: ['STK'], supportedOrderTypes: [] }
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
