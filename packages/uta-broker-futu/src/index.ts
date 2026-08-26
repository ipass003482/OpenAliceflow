import { FutuBroker } from '../../../services/uta/src/domain/trading/brokers/futu/FutuBroker.js'

export const BROKER_PACK_API_VERSION = 1
export const BROKER_ENGINE = 'futu'
export const configSchema = FutuBroker.configSchema

export function createBroker(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }) {
  return Object.assign(FutuBroker.fromConfig(config), { brokerEngine: BROKER_ENGINE })
}
