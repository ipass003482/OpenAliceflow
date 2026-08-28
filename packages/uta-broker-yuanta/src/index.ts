import { YuantaBroker } from '../../../services/uta/src/domain/trading/brokers/yuanta/YuantaBroker.js'

export const BROKER_PACK_API_VERSION = 1
export const BROKER_ENGINE = 'yuanta'
export const configSchema = YuantaBroker.configSchema

export function createBroker(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }) {
  return Object.assign(YuantaBroker.fromConfig(config), { brokerEngine: BROKER_ENGINE })
}
