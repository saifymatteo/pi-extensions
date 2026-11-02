/**
 * decisions.ts — Configured classifier providers and the agent-facing classify tool
 *
 * Sends OpenAI Decisions API requests to compatible endpoints such as oMLX's
 * /v1/decisions endpoint.
 */

import { constants } from 'node:fs'
import { loadServiceConfig, configuredApiKey, serviceApiKey } from './lib/service-models'
import { open, stat, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { truncateHead, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const textSchema = Type.String({ minLength: 1, maxLength: 8192 })
const questionSchema = Type.Union([
  Type.Object({ type: Type.Literal('choice'), instructions: textSchema,
    criteria: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), textSchema, { minProperties: 2, maxProperties: 64 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('bool'), instructions: textSchema,
    criteria: Type.Object({ true: textSchema, false: textSchema }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('score'), instructions: textSchema,
    criteria: Type.Array(textSchema, { minItems: 2, maxItems: 10 }) }, { additionalProperties: false }),
])

function validateQuestions(questions: Record<string, any>) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) ||
      Object.keys(questions).length < 1 || Object.keys(questions).length > 32) {
    throw new Error('classify requires 1..32 named questions')
  }
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 8192
  for (const [name, q] of Object.entries(questions)) {
    if (!name || name.length > 128 || !q || !text(q.instructions)) throw new Error(`Invalid instructions for question ${name}`)
    const criteria = q.criteria
    const labels = criteria && typeof criteria === 'object' ? Object.keys(criteria) : []
    if (q.type === 'choice' && criteria && !Array.isArray(criteria) && labels.length >= 2 && labels.length <= 64 &&
        labels.every(label => label.length > 0 && label.length <= 128 && text(criteria[label]))) continue
    if (q.type === 'bool' && criteria && !Array.isArray(criteria) && labels.length === 2 && text(criteria.true) && text(criteria.false)) continue
    if (q.type === 'score' && Array.isArray(criteria) && criteria.length >= 2 && criteria.length <= 10 && criteria.every(text)) continue
    throw new Error(`Invalid type or criteria for question ${name}`)
  }
}

function validateAnswers(answers: Record<string, any>, questions: Record<string, any>) {
  const range = (value: unknown, max = 1) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
  if (!answers || Object.keys(answers).length !== Object.keys(questions).length ||
      Object.keys(answers).some(name => !Object.hasOwn(questions, name))) throw new Error('Unexpected classifier answer keys')
  for (const [name, q] of Object.entries(questions)) {
    const answer = answers?.[name]
    let valid = answer?.type === q.type
    if (q.type === 'choice') {
      const labels = Object.keys(q.criteria)
      const probabilities: Record<string, number> = answer?.probabilities ?? {}
      valid &&= labels.includes(answer.choice) && Object.keys(probabilities).length === labels.length &&
        labels.every(label => range(probabilities[label])) &&
        Math.abs(Object.values(probabilities).reduce((sum: number, p: any) => sum + p, 0) - 1) <= 0.02 && range(answer.confidence)
    } else if (q.type === 'score') {
      valid &&= range(answer.score, q.criteria.length - 1) && range(answer.confidence)
    } else {
      valid &&= range(answer.probability)
    }
    if (!valid) throw new Error(`Invalid classifier answer for ${name}`)
  }
}

async function loadImages(paths: string[], cwd: string, signal?: AbortSignal) {
  if (!Array.isArray(paths) || paths.length > 4) throw new Error('classify accepts at most 4 local images')
  const images: { type: 'image'; data: string; mimeType: string }[] = []
  let total = 0
  for (const path of paths) {
    signal?.throwIfAborted()
    if (typeof path !== 'string' || !path || /^(https?:|data:)/i.test(path)) throw new Error('images must be local file paths')
    const resolved = resolve(cwd, path.startsWith('~/') ? join(process.env.HOME || process.env.USERPROFILE || '', path.slice(2)) : path)
    const info = await stat(resolved)
    if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('Each image must be a regular file of at most 10 MiB')
    // On POSIX, nonblocking open also protects against a file being swapped for a FIFO after stat.
    const file = await open(resolved, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('Each image must be a regular file of at most 10 MiB')
      const bytes = await file.readFile()
      total += bytes.length
      if (bytes.length > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error('Image input exceeds the 10 MiB per-file or 20 MiB total limit')
      const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined
      if (!mimeType) throw new Error('Unsupported image: use PNG, JPEG, or WebP (detected from file contents)')
      images.push({ type: 'image', data: bytes.toString('base64'), mimeType })
    } finally {
      await file.close()
    }
  }
  signal?.throwIfAborted()
  return images
}

function decisionInput(context: any, model: any) {
  if (context.videos?.length) throw new Error('Native video input is not supported by this adapter')
  const images = context.images ?? []
  if (!Array.isArray(images) || images.length > 4) throw new Error('At most 4 images are supported')
  if (!images.length) return JSON.stringify(context.state)
  if (!model.input?.includes('image')) throw new Error('Selected classifier does not support images')
  let total = 0
  for (const image of images) {
    if (image?.type !== 'image' || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) ||
        typeof image.data !== 'string' || !image.data.length || image.data.length > 14 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('Invalid or unsupported classifier image')
    const decoded = Buffer.from(image.data, 'base64')
    const size = decoded.length
    if (!size || decoded.toString('base64').replace(/=+$/, '') !== image.data.replace(/=+$/, '')) throw new Error('Invalid classifier image base64')
    total += size
    if (size > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error('Classifier image size limit exceeded')
  }
  // OpenAI Decisions message format; do not put base64 inside state as ordinary JSON.
  return [{ role: 'user', content: [
    { type: 'input_text', text: JSON.stringify(context.state) },
    ...images.map((image: any) => ({ type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}` })),
  ] }]
}

function normalizeBaseUrl(baseUrl: string): string {
  // Keep the versioned API base, but remove a legacy endpoint suffix.
  return baseUrl.replace(/\/systemone\/?$/, '')
}

function toDecisionQuestions(questions: Record<string, any>) {
  return Object.entries(questions).map(([name, question]) => {
    if (question.type === 'choice') {
      return {
        type: 'choice',
        name,
        instructions: question.instructions,
        choices: Object.entries(question.criteria || {}).map(([value, description]) =>
          description ? { value, description } : { value }
        ),
      }
    }

    if (question.type === 'score') {
      return {
        type: 'score',
        name,
        instructions: question.instructions,
        levels: (question.criteria || []).map((label: string) => ({ label })),
      }
    }

    const meanings = [
      question.criteria?.true ? `True means: ${question.criteria.true}` : '',
      question.criteria?.false ? `False means: ${question.criteria.false}` : '',
    ].filter(Boolean)
    return {
      type: 'predicate',
      name,
      instructions: [question.instructions, ...meanings].join('\n\n'),
    }
  })
}

function parseAnswers(response: any, questions: Record<string, any>) {
  if (!Array.isArray(response?.answers)) throw new Error('Unexpected Decisions API response')
  const byName = new Map<string, any>(response.answers.map((answer: any) => [answer.name, answer] as [string, any]))
  if (byName.size !== response.answers.length || byName.size !== Object.keys(questions).length) {
    throw new Error('Decisions API returned duplicate, missing, or unexpected answers')
  }
  const answers = Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    const answer = byName.get(name)
    if (!answer || answer.type === 'refusal') throw new Error(`Decisions API did not answer ${name}`)
    if (question.type === 'choice' && answer.type === 'choice') {
      const probabilities = Object.fromEntries((answer.probabilities || []).map((p: any) => [p.value, p.probability]))
      if (Object.keys(probabilities).length !== answer.probabilities?.length) throw new Error(`Invalid probabilities for ${name}`)
      return [name, { type: 'choice', choice: answer.choice, probabilities, confidence: answer.confidence }]
    }
    if (question.type === 'score' && answer.type === 'score') {
      return [name, { type: 'score', score: answer.score, confidence: answer.confidence }]
    }
    if (question.type === 'bool' && answer.type === 'predicate') {
      return [name, { type: 'bool', probability: answer.probability }]
    }
    throw new Error(`Invalid Decisions API answer type for ${name}`)
  }))
  validateAnswers(answers, questions)
  return answers
}

function parseUsage(usage: any, model: any) {
  if (!usage || typeof usage !== 'object' || (usage.input_tokens === undefined && usage.output_tokens === undefined)) {
    return undefined
  }

  const tokenCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  const totalInput = tokenCount(usage.input_tokens)
  const output = tokenCount(usage.output_tokens)
  const cacheRead = tokenCount(usage.input_tokens_details?.cached_tokens)
  const cacheWrite = tokenCount(usage.input_tokens_details?.cache_write_tokens)
  const input = Math.max(0, totalInput - cacheRead - cacheWrite)
  const rates = model.cost || {}
  const cost = {
    input: input * (rates.input || 0) / 1_000_000,
    output: output * (rates.output || 0) / 1_000_000,
    cacheRead: cacheRead * (rates.cacheRead || 0) / 1_000_000,
    cacheWrite: cacheWrite * (rates.cacheWrite || 0) / 1_000_000,
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
  }
}

async function classify(
  providerId: string,
  baseUrl: string,
  configuredKey: string | undefined,
  model: any,
  context: any,
  piDir: string,
  options?: any,
) {
  const output: any = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: 'stop',
    timestamp: Date.now(),
  }

  const signal = AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(30_000)])
  let apiKey: string | undefined
  try {
    signal.throwIfAborted()
    validateQuestions(context.questions)
    if (!context.state || typeof context.state !== 'object' || Array.isArray(context.state)) throw new Error('state must be a JSON object')
    if (Buffer.byteLength(JSON.stringify({ state: context.state, questions: context.questions })) > 256 * 1024) throw new Error('State and questions exceed 256 KiB')
    apiKey = configuredKey !== undefined ? serviceApiKey(piDir, providerId, configuredKey)
      : options?.apiKey || serviceApiKey(piDir, providerId, undefined)
    if (!apiKey) throw new Error(`No API key configured for provider "${providerId}"`)

    const response = await fetch(new URL('decisions', `${normalizeBaseUrl(baseUrl).replace(/\/+$/, '')}/`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.id,
        input: decisionInput(context, model),
        questions: toDecisionQuestions(context.questions),
      }),
      signal,
    })

    if (!response.ok) {
      const body = (await response.text()).slice(0, 1024)
      let message = body || `HTTP ${response.status}`
      try {
        const error = JSON.parse(body)
        message = error.error?.message || error.message || message
      } catch {}
      throw new Error(`Decisions API returned HTTP ${response.status}: ${message}`)
    }

    const result = await response.json()
    output.answers = parseAnswers(result, context.questions)
    output.usage = parseUsage(result.usage, model)
  } catch (error: any) {
    output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
    const message = signal.aborted && signal.reason?.name === 'TimeoutError'
      ? 'Classifier request timed out after 30000ms' : error.message || String(error)
    output.errorMessage = (apiKey ? message.replaceAll(apiKey, '<redacted>') : message).slice(0, 1100)
  }

  return output
}

export default function decisionsExtension(pi: ExtensionAPI) {
  const piDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || '', '.pi', 'agent')
  const config = loadServiceConfig(piDir, 'decisions.json', 'classifier')
  if (!config) return

  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    const { baseUrl, apiKey: configuredKey, models } = providerConfig
    const classifierModels = models.map((model) => ({
      type: 'classifier' as const,
      id: model.id,
      name: model.name ?? model.id,
      api: 'openai-decisions' as const,
      provider: providerId,
      baseUrl: normalizeBaseUrl(baseUrl),
      input: model.input!,
      contextWindow: model.contextWindow!,
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cacheRead: model.cost?.cacheRead ?? 0,
        cacheWrite: model.cost?.cacheWrite ?? 0,
      },
    }))

    pi.registerProvider(providerId, {
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey: configuredApiKey(configuredKey) ?? '',
      models: classifierModels,
      classifiers: {
        'openai-decisions': {
          classify: (model: any, context: any, options?: any) =>
            classify(providerId, baseUrl, configuredKey, model, context, piDir, options),
        },
      },
    })
  }

  const configuredModels = Object.entries(config.providers).flatMap(([provider, cfg]) => cfg.models.map(m => `${provider}/${m.id}`))
  pi.registerTool({
    name: 'classify',
    label: 'Classify',
    description: 'Ask configured classifiers narrow choice, bool, or score questions about JSON state and optional local PNG/JPEG/WebP images. Sends supplied data to the selected provider. 30-second request timeout; no retries or provider fallback. Video is not supported by this tool. Large output is saved to a temporary file.',
    promptSnippet: 'Classify, route, or score text and images with a configured specialist model',
    promptGuidelines: [
      'Use classify for repeated narrow semantic judgments, batch-item classification, or image judgments with explicit criteria; prefer code for exact rules and the main model for ordinary one-off reasoning.',
      'Ask independent questions about the same state together. Supply all evidence; use a no-match/unknown choice when needed. Image paths are local files whose pixels will be sent to the provider.',
      'Treat classifier confidence as a model signal, not calibrated correctness or permission to act. Do not use it as an authoritative security gate, send secrets, or silently retry failures with another provider.',
    ],
    parameters: Type.Object({
      state: Type.Record(Type.String(), Type.Any(), { description: 'Shared JSON object containing the evidence to judge; use {} for image-only questions.' }),
      questions: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), questionSchema, { minProperties: 1, maxProperties: 32 }),
      images: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 4, description: 'Local image paths, relative to cwd or absolute. Max 10 MiB each, 20 MiB total; PNG, JPEG, WebP.' })),
      model: Type.Optional(Type.String({ description: `Configured provider/model-id. Defaults only when exactly one is configured. Options: ${configuredModels.join(', ')}` })),
    }, { additionalProperties: false }),
    outputSchema: Type.Object({ provider: Type.String(), model: Type.String(), answers: Type.Record(Type.String(), Type.Any()), usage: Type.Optional(Type.Any()) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted()
      if ('videos' in params) throw new Error('Native video input is not supported by classify')
      validateQuestions(params.questions)
      const spec = params.model ?? (configuredModels.length === 1 ? configuredModels[0] : undefined)
      if (!spec) throw new Error(`Specify model; configured models: ${configuredModels.join(', ')}`)
      if (!configuredModels.includes(spec)) throw new Error(`Model is not configured in decisions.json: ${spec}`)
      const slash = spec.indexOf('/')
      const model = ctx.modelRegistry.findOfType('classifier', spec.slice(0, slash), spec.slice(slash + 1))
      if (!model) throw new Error(`Configured classifier is not registered: ${spec}`)
      if (params.images?.length && !model.input.includes('image')) throw new Error(`Model ${spec} does not support images`)
      const images = await loadImages(params.images ?? [], ctx.cwd, signal)
      const result = await ctx.modelRegistry.classify(model, { state: params.state, questions: params.questions, ...(images.length ? { images } : {}) }, { signal })
      if (result.stopReason !== 'stop') throw new Error(result.errorMessage || `Classifier ${result.stopReason}`)
      signal?.throwIfAborted()
      validateAnswers(result.answers, params.questions)
      const payload = { provider: result.provider, model: result.model, answers: result.answers, usage: result.usage }
      const json = JSON.stringify(payload, null, 2)
      const truncated = truncateHead(json, { maxBytes: 48 * 1024, maxLines: 1900 })
      let text = truncated.content
      if (truncated.truncated) {
        const path = join(await mkdtemp(join(tmpdir(), 'pi-classify-')), 'result.json')
        await writeFile(path, json, { encoding: 'utf8', mode: 0o600 })
        text += `\n[Output truncated. Full JSON: ${path}]`
      }
      return { content: [{ type: 'text', text }], details: payload, structuredContent: payload as any, usage: result.usage }
    },
  })
}
