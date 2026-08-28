import { Contract, ContractDescription } from '@traderalice/ibkr'
import '../../contract-ext.js'
import { buildContract } from '../contract-builder.js'

export type YuantaMarket = 'TWSE' | 'TPEx'

export function parseYuantaKey(key: string): { market: YuantaMarket; code: string } {
  const normalized = key.trim()
  const separator = normalized.indexOf(':')
  if (separator < 0) return { market: 'TWSE', code: normalized }
  const market = normalized.slice(0, separator).toUpperCase()
  return { market: market === 'TPEX' || market === 'OTC' ? 'TPEx' : 'TWSE', code: normalized.slice(separator + 1) }
}

export function makeYuantaContract(key: string, description?: string): Contract {
  const { market, code } = parseYuantaKey(key)
  const contract = buildContract({
    symbol: code,
    localSymbol: `${market}:${code}`,
    secType: 'STK',
    exchange: market === 'TWSE' ? 'TWSE' : 'TPEX',
    primaryExchange: market === 'TWSE' ? 'TWSE' : 'TPEX',
    currency: 'TWD',
  })
  if (description) contract.description = description
  return contract
}

export function resolveYuantaKey(contract: Contract): string | null {
  if (contract.localSymbol?.includes(':')) return contract.localSymbol
  if (contract.aliceId?.includes('|')) return contract.aliceId.slice(contract.aliceId.indexOf('|') + 1)
  if (!contract.symbol) return null
  const market = contract.exchange?.toUpperCase() === 'TPEX' ? 'TPEx' : 'TWSE'
  return `${market}:${contract.symbol}`
}

export function yuantaDescription(key: string, description?: string): ContractDescription {
  const row = new ContractDescription()
  row.contract = makeYuantaContract(key, description)
  return row
}
