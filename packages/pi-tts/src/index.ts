/** Generate WAV files through an OpenAI-compatible speech endpoint; never play audio. */
import { loadServiceConfig, serviceApiKey } from './lib/service-models'
import { link, lstat, mkdtemp, open, rm, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const MAX_AUDIO_BYTES = 100 * 1024 * 1024
const MAX_TEXT_LENGTH = 20_000

async function readAudio(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error('TTS audio exceeds 100 MiB')
  }
  if (!response.body) throw new Error('TTS API returned no audio')
  const reader = response.body.getReader()
  // Also interrupt non-fetch/custom streams that do not observe the request signal.
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_AUDIO_BYTES) throw new Error('TTS audio exceeds 100 MiB')
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  signal.throwIfAborted()
  const audio = Buffer.concat(chunks, size)
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.readUInt32LE(4) !== audio.length - 8) {
    throw new Error('TTS API did not return a WAV file')
  }
  return audio
}

export default function ttsExtension(pi: ExtensionAPI) {
  const piDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || '', '.pi', 'agent')
  const config = loadServiceConfig(piDir, 'tts.json', 'tts')
  if (!config) return
  const models = Object.entries(config.providers).flatMap(([provider, cfg]) =>
    cfg.models.map(model => ({ spec: `${provider}/${model.id}`, provider, config: cfg, model })))

  pi.registerTool({
    name: 'text_to_speech',
    label: 'Text to speech',
    description: 'Generate a local WAV audio file from narration using a configured OpenAI-compatible TTS server. Sends the supplied text to that server. Never plays audio or overwrites files. 120-second timeout; no retries or fallback. Maximum 20,000 characters and 100 MiB output.',
    promptSnippet: 'Generate spoken narration as a WAV file with a configured TTS model',
    promptGuidelines: [
      'Use text_to_speech when the user requests spoken narration or an audio file; do not generate or play audio automatically.',
      'Write listener-friendly narration rather than reading Markdown syntax or code verbatim, unless the user requests exact text. Return the saved file path.',
      'Use only models configured in tts.json. Do not send secrets or silently switch providers after a failure.',
    ],
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH, description: 'Narration to synthesize.' }),
      output_file: Type.String({ minLength: 1, description: 'New .wav file, relative to cwd or absolute. Parent directory must exist. Existing files are never overwritten.' }),
      model: Type.Optional(Type.String({ description: `Configured provider/model-id. Defaults only when exactly one is configured. Options: ${models.map(m => m.spec).join(', ') || '(none; add a model to tts.json)'}` })),
      voice: Type.Optional(Type.String({ minLength: 1, description: 'Voice supported by the selected model; otherwise uses the configured/server default.' })),
      language: Type.Optional(Type.String({ minLength: 1, description: 'Language supported by the selected model; otherwise uses the configured/server default.' })),
    }, { additionalProperties: false }),
    outputSchema: Type.Object({ provider: Type.String(), model: Type.String(), output_file: Type.String(), bytes: Type.Number(), format: Type.Literal('wav') }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted()
      if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > MAX_TEXT_LENGTH) throw new Error('Narration must contain 1..20000 characters')
      if (typeof params.output_file !== 'string' || !params.output_file.trim() || params.output_file.includes('\0') || extname(params.output_file).toLowerCase() !== '.wav') throw new Error('output_file must be a new .wav file')
      for (const value of [params.voice, params.language]) {
        if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new Error('voice and language must be non-empty strings')
      }
      const spec = params.model ?? (models.length === 1 ? models[0].spec : undefined)
      const selected = models.find(m => m.spec === spec)
      if (!selected) throw new Error(`Specify a model configured in tts.json. Options: ${models.map(m => m.spec).join(', ') || '(none)'}`)
      const output = resolve(ctx.cwd, params.output_file.startsWith('~/') ? join(process.env.HOME || process.env.USERPROFILE || '', params.output_file.slice(2)) : params.output_file)
      try {
        await lstat(output)
        throw new Error('output_file already exists; choose a new path')
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error
      }
      // Fail before a potentially expensive synthesis request if the parent is absent.
      const parent = await stat(dirname(output))
      if (!parent.isDirectory()) throw new Error('output_file parent must be a directory')
      const key = serviceApiKey(piDir, selected.provider, selected.config.apiKey)
      const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)])
      try {
        const response = await fetch(new URL('audio/speech', `${selected.config.baseUrl.replace(/\/+$/, '')}/`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({
            model: selected.model.id,
            input: params.text,
            response_format: 'wav',
            voice: params.voice ?? selected.model.voice,
            language: params.language ?? selected.model.language,
          }),
          signal: requestSignal,
          redirect: 'error',
        })
        // Do not echo server response bodies: they may contain credentials or narration.
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new Error(`TTS API returned HTTP ${response.status}`)
        }
        const audio = await readAudio(response, requestSignal)
        requestSignal.throwIfAborted()
        // Stage privately on the same filesystem, then publish atomically without replacing anything.
        // Cleanup never touches output: it may have been replaced by another process.
        const staging = await mkdtemp(join(dirname(output), '.pi-tts-'))
        try {
          const staged = join(staging, 'audio.wav')
          const file = await open(staged, 'wx', 0o600)
          try { await file.writeFile(audio, { signal: requestSignal }) } finally { await file.close() }
          requestSignal.throwIfAborted()
          await link(staged, output)
        } finally {
          await rm(staging, { recursive: true, force: true }).catch(() => {})
        }
        const result = { provider: selected.provider, model: selected.model.id, output_file: output, bytes: audio.length, format: 'wav' as const }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, structuredContent: result }
      } catch (error: any) {
        if (signal?.aborted) throw new Error('TTS generation aborted')
        if (requestSignal.aborted && requestSignal.reason?.name === 'TimeoutError') throw new Error('TTS request timed out after 120000ms')
        const message = error.message || String(error)
        throw new Error((key ? message.replaceAll(key, '<redacted>') : message).slice(0, 1100))
      }
    },
  })
}
