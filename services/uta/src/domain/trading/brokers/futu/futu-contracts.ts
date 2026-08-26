/**
 * Contract resolution helpers for Futu.
 *
 * On the wire a Futu instrument is `Security { market: int, code: string }`
 * (Qot_Common.proto). This adapter's broker-native key is the string form
 * `"<MARKET>.<code>"` — e.g. `"HK.00700"`, `"US.AAPL"`, `"SH.600519"` —
 * an internal representation choice mirroring the market/code pair, chosen
 * so the key round-trips losslessly through `Contract.localSymbol` and
 * `aliceId` exactly like the Longbridge adapter's suffixed symbols.
 */

import { Contract, ContractDescription } from '@traderalice/ibkr'
import '../../contract-ext.js'
import { buildContract } from '../contract-builder.js'
import { FutuQotMarket, FutuTrdSecMarket, type FutuSecurity } from './futu-types.js'

/** Per-market-prefix metadata: QotMarket enum + IBKR-style exchange/currency. */
interface PrefixInfo {
  qotMarket: number
  exchange: string
  currency: string
}

/**
 * SH/SZ use CNH because Trd_Common.Currency only defines CNH (offshore RMB);
 * Futu has no CNY enum value.
 */
const PREFIX_TABLE: Record<string, PrefixInfo> = {
  HK: { qotMarket: FutuQotMarket.HK, exchange: 'SEHK', currency: 'HKD' },
  US: { qotMarket: FutuQotMarket.US, exchange: 'SMART', currency: 'USD' },
  SH: { qotMarket: FutuQotMarket.SH, exchange: 'SSE', currency: 'CNH' },
  SZ: { qotMarket: FutuQotMarket.SZ, exchange: 'SZSE', currency: 'CNH' },
  SG: { qotMarket: FutuQotMarket.SG, exchange: 'SGX', currency: 'SGD' },
  JP: { qotMarket: FutuQotMarket.JP, exchange: 'TSEJ', currency: 'JPY' },
}

/** QotMarket enum value → key prefix (reverse of PREFIX_TABLE). */
const QOT_MARKET_TO_PREFIX: Record<number, string> = {
  [FutuQotMarket.HK]: 'HK',
  [FutuQotMarket.US]: 'US',
  [FutuQotMarket.SH]: 'SH',
  [FutuQotMarket.SZ]: 'SZ',
  [FutuQotMarket.SG]: 'SG',
  [FutuQotMarket.JP]: 'JP',
}

/** Trd_Common.TrdSecMarket enum value → key prefix (positions carry this). */
const TRD_SEC_MARKET_TO_PREFIX: Record<number, string> = {
  [FutuTrdSecMarket.HK]: 'HK',
  [FutuTrdSecMarket.US]: 'US',
  [FutuTrdSecMarket.SH]: 'SH',
  [FutuTrdSecMarket.SZ]: 'SZ',
  [FutuTrdSecMarket.SG]: 'SG',
  [FutuTrdSecMarket.JP]: 'JP',
}

/** Parse `"HK.00700"` → `{ prefix: "HK", code: "00700" }`. Bare codes default to US. */
export function parseFutuKey(key: string): { prefix: string; code: string } {
  const idx = key.indexOf('.')
  if (idx < 0) return { prefix: 'US', code: key.toUpperCase() }
  const prefix = key.slice(0, idx).toUpperCase()
  const code = key.slice(idx + 1)
  if (!(prefix in PREFIX_TABLE)) return { prefix: 'US', code: key.toUpperCase() }
  return { prefix, code }
}

/** Build a fully qualified IBKR Contract for a Futu key (STK only in this increment). */
export function makeContract(futuKey: string): Contract {
  const { prefix, code } = parseFutuKey(futuKey)
  const info = PREFIX_TABLE[prefix] ?? PREFIX_TABLE['US']
  return buildContract({
    symbol: code,
    localSymbol: `${prefix}.${code}`,
    secType: 'STK',
    exchange: info.exchange,
    currency: info.currency,
  })
}

/** Wire Security → key string. Unknown markets fall back to the US prefix. */
export function securityToKey(security: FutuSecurity): string {
  const prefix = QOT_MARKET_TO_PREFIX[security.market] ?? 'US'
  return `${prefix}.${security.code}`
}

/** Key string → wire Security. */
export function keyToSecurity(futuKey: string): FutuSecurity {
  const { prefix, code } = parseFutuKey(futuKey)
  const info = PREFIX_TABLE[prefix] ?? PREFIX_TABLE['US']
  return { market: info.qotMarket, code }
}

/** TrdSecMarket enum (positions) → key prefix; unknown → US. */
export function trdSecMarketToPrefix(secMarket: number | undefined): string {
  if (secMarket === undefined) return 'US'
  return TRD_SEC_MARKET_TO_PREFIX[secMarket] ?? 'US'
}

/** Default contract currency for a key prefix. */
export function currencyForPrefix(prefix: string): string {
  return (PREFIX_TABLE[prefix] ?? PREFIX_TABLE['US']).currency
}

/**
 * Resolve a Contract back to a Futu key (e.g. "HK.00700").
 *
 * Preferred sources, in order:
 *   1. `localSymbol` — set by makeContract; round-trips losslessly.
 *   2. `aliceId` after the `|` separator — the UTA-stamped native key.
 *   3. `symbol` + currency-derived prefix — best-effort fallback.
 */
export function resolveFutuKey(contract: Contract): string | null {
  if (contract.localSymbol && contract.localSymbol.includes('.')) {
    const { prefix } = parseFutuKey(contract.localSymbol)
    if (prefix in PREFIX_TABLE) return contract.localSymbol
  }
  if (contract.aliceId) {
    const idx = contract.aliceId.indexOf('|')
    if (idx >= 0) {
      const native = contract.aliceId.slice(idx + 1)
      if (native.includes('.')) return native
    }
  }
  if (!contract.symbol) return null
  const prefix = inferPrefixFromCurrency(contract.currency)
  return `${prefix}.${contract.symbol}`
}

function inferPrefixFromCurrency(currency: string | undefined): string {
  switch ((currency ?? '').toUpperCase()) {
    case 'HKD': return 'HK'
    // Ambiguous — SH wins over SZ for stable inference (mirrors Longbridge).
    case 'CNY':
    case 'CNH': return 'SH'
    case 'SGD': return 'SG'
    case 'JPY': return 'JP'
    default: return 'US'
  }
}

/** Produce a single-result ContractDescription for echo-style search fallback. */
export function echoContractDescription(futuKey: string): ContractDescription {
  const desc = new ContractDescription()
  desc.contract = makeContract(futuKey)
  return desc
}
