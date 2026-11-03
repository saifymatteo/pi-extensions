import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ServiceModel {
  id: string
  type: 'classifier' | 'tts'
  api: 'openai-decisions' | 'openai-audio-speech'
  name?: string
  /** One-line strength hint shown in the tool's model options. */
  description?: string
  contextWindow?: number
  input?: ('text' | 'image')[]
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  voice?: string
  language?: string
}
export interface ServiceProvider {
  baseUrl: string
  apiKey?: string
  models: ServiceModel[]
}
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: any): value is string => typeof value === 'string' && !!value.trim()

/** Each extension uses every registry model of its `type`; a missing registry or no matching models disables the tool. */
export function loadServiceConfig(piDir: string, type: ServiceModel['type']): { providers: Record<string, ServiceProvider> } | undefined {
  const path = join(piDir, 'extensions', 'service-models.json')
  if (!existsSync(path)) return undefined
  try {
    let registry: any
    try { registry = JSON.parse(readFileSync(path, 'utf8')) }
    catch { throw new Error('Malformed JSON') }
    if (!object(registry) || !object(registry.providers)) throw new Error('requires a providers object')
    const providers: Record<string, ServiceProvider> = Object.create(null)
    for (const [id, provider] of Object.entries(registry.providers)) {
      if (!text(id) || id.includes('/') || !object(provider) || !text(provider.baseUrl) ||
          (provider.apiKey !== undefined && typeof provider.apiKey !== 'string') || !Array.isArray(provider.models)) {
        throw new Error(`Invalid provider: ${id}`)
      }
      let url: URL
      try { url = new URL(provider.baseUrl) } catch { throw new Error(`Invalid baseUrl for provider: ${id}`) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`Invalid baseUrl for provider: ${id}`)
      const ids = new Set<string>()
      for (const model of provider.models) {
        if (!object(model) || !text(model.id) || ids.has(model.id) ||
            !['tts', 'classifier'].includes(model.type) || model.api !== (model.type === 'tts' ? 'openai-audio-speech' : 'openai-decisions') ||
            (model.name !== undefined && !text(model.name)) ||
            (model.description !== undefined && !text(model.description)) ||
            ['voice', 'language'].some(key => model[key] !== undefined && (model.type !== 'tts' || !text(model[key]))) ||
            (model.type === 'classifier' && (model.contextWindow === undefined || model.input === undefined)) ||
            (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) ||
            (model.input !== undefined && (!Array.isArray(model.input) || !model.input.length ||
              new Set(model.input).size !== model.input.length || model.input.some((input: any) => !['text', 'image'].includes(input)))) ||
            (model.cost !== undefined && (!object(model.cost) || !['input', 'output'].every(key => typeof model.cost[key] === 'number') ||
              Object.entries(model.cost).some(([key, value]) => !['input', 'output', 'cacheRead', 'cacheWrite'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0)))) {
          throw new Error(`Invalid or duplicate model in provider: ${id}`)
        }
        ids.add(model.id)
        if (model.type !== type) continue
        providers[id] ??= { baseUrl: provider.baseUrl, ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}), models: [] }
        providers[id].models.push({ ...model } as ServiceModel)
      }
    }
    return Object.keys(providers).length ? { providers } : undefined
  } catch (error: any) {
    // Never echo JSON parser messages, URLs or credential values from configuration.
    throw new Error(`Failed to load service-models.json: ${error.message}`)
  }
}

/** Lists each `provider/model-id` with its description, for a tool's model parameter. */
export function modelOptions(config: { providers: Record<string, ServiceProvider> }): string {
  return Object.entries(config.providers).flatMap(([provider, cfg]) =>
    cfg.models.map(model => `\n- ${provider}/${model.id}${model.description ? `: ${model.description}` : ''}`)).join('')
}

export function configuredApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const envName = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value)?.[1]
    ?? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1]
  return envName ? process.env[envName] : value
}

export function serviceApiKey(piDir: string, id: string, configured: string | undefined): string {
  if (configured !== undefined) {
    const key = configuredApiKey(configured)
    if (key === undefined || (configured !== '' && !key)) throw new Error('No API key: Missing API key environment variable for configured service provider')
    return key
  }
  let auth: any
  try { auth = JSON.parse(readFileSync(join(piDir, 'auth.json'), 'utf8')) } catch {}
  const key = auth?.[id]?.key ?? auth?.[id]?.access
  if (typeof key !== 'string' || !key) throw new Error(`No API key configured for provider "${id}"; use auth.json or service-models.json apiKey ("" for keyless access)`)
  return key
}
