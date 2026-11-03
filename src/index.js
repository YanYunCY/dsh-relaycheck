// dsh-relaycheck: exposes relaycheck (https://github.com/YanYunCY/relaycheck) as a dsh tool.
// The model only ever names a configured target; base URLs and key env var names
// come from the plugin config, so a prompt injection cannot point a key at another host.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-relaycheck'
export const inject = ['tools']
export const TOOL_NAME = 'relay_check'

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const Target = Schema.object({
  baseUrl: Schema.string().required().description('Relay base URL, e.g. https://relay.example.com'),
  model: Schema.string().description('Model to test. Empty: the model of the calling session, when its provider matches.'),
  api: Schema.union(['auto', 'anthropic', 'openai', 'responses']).default('auto'),
  keyEnv: Schema.string().default('RELAY_KEY').description('Name of the environment variable that holds the relay key. The key itself never goes in config.'),
  provider: Schema.string().description('dsh provider id this relay backs; lets the tool pick this target for "the relay I am using now".'),
  ref: Schema.string().description('Path to a reference fingerprint JSON (relaycheck --ref). Default: refs/<model>.json shipped with relaycheck.'),
})

export const Config = Schema.object({
  targets: Schema.dict(Target).default({}).description('Named relays the agent may check.'),
  defaultTarget: Schema.string().description('Target used when the call names none and no provider matches.'),
  samples: Schema.natural().min(1).max(200).default(16).description('Samples per identity probe (relaycheck --samples).'),
  probes: Schema.string().default('identity,protocol,billing,context').description('Groups to run.'),
  allowDeep: Schema.boolean().default(false).description('Allow the agent to request --deep (about 100k extra input tokens).'),
  requireApproval: Schema.boolean().default(true).description('Ask the user before every check, since a check spends relay tokens.'),
  lang: Schema.union(['en', 'zh']).default('en'),
  timeoutSeconds: Schema.natural().min(10).default(600),
})

const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['id', 'status', 'summary'],
  additionalProperties: false,
}

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string' },
    host: { type: 'string' },
    model: { type: 'string' },
    api: { type: 'string' },
    verdict: { type: 'string', enum: ['consistent', 'inconsistent', 'inconclusive'] },
    headline: { type: 'string' },
    pValue: { type: 'number' },
    calibrated: { type: 'boolean' },
    injectedTokens: { type: 'integer' },
    exitCode: { type: 'integer' },
    groups: { type: 'array', items: GROUP_SCHEMA },
    usage: {
      type: 'object',
      properties: { inputTokens: { type: 'integer' }, outputTokens: { type: 'integer' }, requests: { type: 'integer' } },
      required: ['inputTokens', 'outputTokens', 'requests'],
      additionalProperties: false,
    },
    durationMs: { type: 'integer' },
  },
  required: ['target', 'host', 'model', 'api', 'verdict', 'headline', 'calibrated', 'exitCode', 'groups', 'usage', 'durationMs'],
  additionalProperties: false,
}

/** Locate relaycheck's CLI inside the installed npm package. */
export function relaycheckCli() {
  const require = createRequire(import.meta.url)
  return join(require.resolve('relaycheck/package.json'), '..', 'dist', 'cli.js')
}

/**
 * Pick the target for one call. Throws a model-readable Error when none fits.
 * @returns {{ id: string, target: object, model: string }}
 */
export function resolveTarget(config, args, session) {
  const targets = config.targets ?? {}
  const ids = Object.keys(targets)
  if (ids.length === 0) throw new Error('relay_check has no configured targets. Ask the user to add one under targets in the dsh-relaycheck plugin config.')
  let id = args.target
  if (id !== undefined && !(id in targets)) throw new Error(`unknown target "${id}". Configured targets: ${ids.join(', ')}`)
  if (id === undefined && session?.provider) id = ids.find((k) => targets[k].provider === session.provider)
  if (id === undefined) id = config.defaultTarget ?? (ids.length === 1 ? ids[0] : undefined)
  if (id === undefined || !(id in targets)) throw new Error(`no target matches the current session; name one of: ${ids.join(', ')}`)
  const target = targets[id]
  const sameProvider = session?.provider !== undefined && target.provider === session.provider
  const model = args.model ?? target.model ?? (sameProvider ? session.model : undefined)
  if (!model) throw new Error(`target "${id}" has no model; pass model or set targets.${id}.model`)
  return { id, target, model }
}

/** Build relaycheck argv. Pure, for tests. */
export function buildArgv(cli, target, model, config, args, jsonPath) {
  const keyEnv = target.keyEnv ?? 'RELAY_KEY'
  if (!ENV_NAME.test(keyEnv)) throw new Error(`keyEnv "${keyEnv}" is not an environment variable name`)
  const argv = [cli, target.baseUrl, '--model', model, '--api', target.api ?? 'auto', '--key-env', keyEnv,
    '--samples', String(config.samples ?? 16), '--probes', args.probes ?? config.probes ?? 'identity,protocol,billing,context',
    '--lang', config.lang ?? 'en', '--json', jsonPath, '--quiet', '--no-color']
  if (target.ref) argv.push('--ref', target.ref)
  if (args.deep === true) {
    if (!config.allowDeep) throw new Error('deep mode is disabled in the dsh-relaycheck config (allowDeep: false)')
    argv.push('--deep')
  }
  return argv
}

const pick = (l10n, lang) => (typeof l10n === 'string' ? l10n : l10n?.[lang] ?? l10n?.en ?? '')

/** Reduce a relaycheck JSON report to the tool's canonical value. */
export function summarize(report, meta, lang) {
  const groups = (report.groups ?? []).map((g) => ({ id: String(g.id), status: String(g.status), summary: pick(g.summary, lang) }))
  const p = report.pValue
  const u = report.usage ?? {}
  return {
    target: meta.id,
    host: meta.host,
    model: meta.model,
    api: String(report.target?.api ?? meta.api),
    verdict: report.verdict,
    headline: pick(report.headline, lang),
    ...(typeof p === 'number' && Number.isFinite(p) ? { pValue: p } : {}),
    calibrated: report.calibrated === true,
    ...(typeof report.injectedTokens === 'number' ? { injectedTokens: Math.trunc(report.injectedTokens) } : {}),
    exitCode: meta.exitCode,
    groups,
    usage: {
      inputTokens: Math.trunc(u.inputTokens ?? 0),
      outputTokens: Math.trunc(u.outputTokens ?? 0),
      requests: Math.trunc(u.requests ?? 0),
    },
    durationMs: Math.trunc(report.durationMs ?? meta.durationMs ?? 0),
  }
}

export function render(value) {
  const lines = [
    `relaycheck ${value.target} (${value.host}, model ${value.model}, api ${value.api}): ${value.verdict.toUpperCase()}`,
    value.headline,
    ...value.groups.map((g) => `- ${g.id}: ${g.status}, ${g.summary}`),
  ]
  if (value.pValue !== undefined) lines.push(`identity p-value: ${value.pValue.toPrecision(3)}${value.calibrated ? '' : ' (uncalibrated reference)'}`)
  if (value.injectedTokens) lines.push(`relay appears to inject about ${value.injectedTokens} hidden prompt tokens per request`)
  lines.push(`spent ${value.usage.inputTokens} input / ${value.usage.outputTokens} output tokens over ${value.usage.requests} requests in ${Math.round(value.durationMs / 1000)}s`)
  lines.push('A statistical check, not proof: "inconsistent" means the answers do not match the reference model at the configured confidence.')
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

/** Run relaycheck as a child process; resolves with { code, stderr }. */
export function runCli(argv, { signal, timeoutMs, env = process.env, execPath = process.execPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, argv, { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000) })
    const kill = () => child.kill('SIGTERM')
    const timer = setTimeout(kill, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code, sig) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
      resolve({ code: code ?? (sig ? 3 : 0), stderr, signal: sig })
    })
  })
}

function sessionInfo(agent) {
  try {
    const cfg = agent?.session?.requestHeader?.()?.config
    return cfg ? { provider: cfg.provider, model: cfg.model } : undefined
  } catch { return undefined }
}

export function createTool(config, deps = {}) {
  const cli = deps.cli ?? relaycheckCli()
  const ids = Object.keys(config.targets ?? {})
  return {
    name: TOOL_NAME,
    description: [
      'Check whether an LLM API relay (中转) really serves the model it claims, using relaycheck.',
      'Runs identity probes (statistical fingerprint vs. a reference), protocol checks, billing (reported vs. real token counts) and a context-length needle test.',
      `Costs real relay tokens and takes one to several minutes. Configured targets: ${ids.length ? ids.join(', ') : '(none yet)'}.`,
      'Omit target to check the relay behind the current session.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Configured target name.', ...(ids.length ? { enum: ids } : {}) },
        model: { type: 'string', description: 'Model name to test; defaults to the target model or the current session model.' },
        probes: { type: 'string', description: 'Comma list from identity,protocol,billing,context.' },
        deep: { type: 'boolean', description: 'Larger context probe (~100k extra input tokens). Only if the user asked for it.' },
      },
      additionalProperties: false,
    },
    timeoutMs: (config.timeoutSeconds ?? 600) * 1000 + 15000,
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => render(value) },
    async execute(rawArgs, exec) {
      const args = rawArgs ?? {}
      const { id, target, model } = resolveTarget(config, args, sessionInfo(exec?.agent))
      const keyEnv = target.keyEnv ?? 'RELAY_KEY'
      const env = deps.env ?? process.env
      if (!env[keyEnv]) throw new Error(`environment variable ${keyEnv} is not set for target "${id}"; the user must export it before starting dsh`)
      const dir = await mkdtemp(join(tmpdir(), 'dsh-relaycheck-'))
      const started = Date.now()
      try {
        const jsonPath = join(dir, 'report.json')
        const argv = buildArgv(cli, target, model, config, args, jsonPath)
        const run = deps.runCli ?? runCli
        const { code, stderr } = await run(argv, { signal: exec?.signal, timeoutMs: (config.timeoutSeconds ?? 600) * 1000, env })
        let report
        try { report = JSON.parse(await readFile(jsonPath, 'utf8')) } catch {
          const tail = stderr.trim().split('\n').slice(-3).join(' ').replaceAll(env[keyEnv], '***')
          throw new Error(`relaycheck failed (exit ${code})${tail ? `: ${tail}` : ''}`)
        }
        return summarize(report, { id, host: new URL(target.baseUrl).host, model, api: target.api ?? 'auto', exitCode: code, durationMs: Date.now() - started }, config.lang ?? 'en')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

export function apply(ctx, config) {
  const tool = createTool(config)
  ctx.tools.register(tool)
  if (config.requireApproval !== false) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== TOOL_NAME) return next()
      return {
        kind: 'ask',
        reason: 'relay_check sends dozens of requests to the relay and spends its tokens.',
        displayReason: { en: 'Run relaycheck? It spends relay tokens.', zh: '运行 relaycheck 验货？会消耗中转的 token。' },
      }
    })
  }
}
