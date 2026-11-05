import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { Config, buildArgv, createTool, relaycheckCli, resolveTarget, summarize, render, apply, TOOL_NAME } from '../src/index.js'

const cfg = (over = {}) => new Schema(Config)({ targets: { local: { baseUrl: 'http://127.0.0.1:1', model: 'm', provider: 'myrelay' } }, ...over })

test('config fills defaults and needs approval by default', () => {
  const c = cfg()
  assert.equal(c.samples, 16)
  assert.equal(c.requireApproval, true)
  assert.equal(c.allowDeep, false)
  assert.equal(c.targets.local.keyEnv, 'RELAY_KEY')
})

test('target resolution: explicit, by session provider, single default, unknown', () => {
  const c = new Schema(Config)({ targets: { a: { baseUrl: 'http://a', provider: 'pa' }, b: { baseUrl: 'http://b', model: 'mb' } } })
  assert.equal(resolveTarget(c, { target: 'b' }).model, 'mb')
  const r = resolveTarget(c, {}, { provider: 'pa', model: 'deepseek-v4' })
  assert.deepEqual([r.id, r.model], ['a', 'deepseek-v4'])
  assert.throws(() => resolveTarget(c, {}), /no target matches/)
  assert.throws(() => resolveTarget(c, { target: 'evil' }), /unknown target/)
  assert.throws(() => resolveTarget(new Schema(Config)({}), {}), /no configured targets/)
})

test('schemas pass dsh-tools validation (the host rejects type arrays etc.)', () => {
  const tool = createTool(cfg(), { cli: 'x' })
  assertObjectJsonSchema(tool.output.schema)
  assertSupportedJsonSchema(tool.parameters)
})

test('model cannot pick a base URL or a key variable', () => {
  const tool = createTool(cfg(), { cli: 'x' })
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['deep', 'model', 'probes', 'target'])
  assert.equal(tool.parameters.additionalProperties, false)
})

test('argv: key passed by env name only, deep gated', () => {
  const c = cfg()
  const argv = buildArgv('cli.js', c.targets.local, 'm', c, {}, '/tmp/r.json')
  assert.deepEqual(argv.slice(0, 8), ['cli.js', 'http://127.0.0.1:1', '--model', 'm', '--api', 'auto', '--key-env', 'RELAY_KEY'])
  assert.ok(argv.includes('--json') && argv.includes('--quiet'))
  assert.throws(() => buildArgv('cli.js', c.targets.local, 'm', c, { deep: true }, 'x'), /deep mode is disabled/)
  assert.ok(buildArgv('cli.js', c.targets.local, 'm', cfg({ allowDeep: true }), { deep: true }, 'x').includes('--deep'))
  assert.throws(() => buildArgv('cli.js', { ...c.targets.local, keyEnv: 'A;rm -rf' }, 'm', c, {}, 'x'), /not an environment variable name/)
})

test('missing key env fails with a model-readable error before any request', async () => {
  const tool = createTool(cfg(), { cli: 'x', env: {}, runCli: () => assert.fail('must not run') })
  await assert.rejects(tool.execute({}, {}), /RELAY_KEY is not set/)
})

test('relay key never appears in errors, even when relaycheck echoes it', async () => {
  const key = 'sk-secret-ABC123xyz'
  let seenEnv
  const tool = createTool(cfg(), { cli: 'x', env: { RELAY_KEY: key }, runCli: async (argv, opts) => {
    seenEnv = opts.env
    assert.ok(!argv.includes(key), 'key must not be on argv')
    return { code: 2, stderr: `401 Unauthorized for Bearer ${key}\nretry with ${key}` }
  } })
  const err = await tool.execute({}, {}).then(() => assert.fail('should throw'), (e) => e)
  assert.match(err.message, /relaycheck failed \(exit 2\)/)
  assert.ok(!err.message.includes(key), err.message)
  assert.equal(seenEnv.RELAY_KEY, key)
})

test('approval gate asks only for relay_check', async () => {
  const handlers = {}
  const ctx = { tools: { register: (t) => { handlers.tool = t } }, effect: (f) => f(), on: (e, f) => { handlers[e] = f } }
  apply(ctx, cfg())
  assert.equal(handlers.tool.name, TOOL_NAME)
  assert.equal((await handlers['tools/pre-execute']({ name: TOOL_NAME }, async () => ({ kind: 'allow' }))).kind, 'ask')
  assert.equal((await handlers['tools/pre-execute']({ name: 'bash' }, async () => ({ kind: 'allow' }))).kind, 'allow')
})

test('summarize + render', () => {
  const v = summarize({ verdict: 'inconsistent', headline: { en: 'swap', zh: '调包' }, pValue: 0.0001, calibrated: false, injectedTokens: null, target: { api: 'anthropic' }, usage: { requests: 3, inputTokens: 10, outputTokens: 5 }, durationMs: 1200, groups: [{ id: 'identity', status: 'fail', summary: { en: 'differs', zh: '不同' } }] }, { id: 'local', host: 'h', model: 'm', api: 'auto', exitCode: 1 }, 'zh')
  assert.equal(v.headline, '调包')
  assert.equal(v.groups[0].summary, '不同')
  assert.match(render(v)[0].text, /INCONSISTENT/)
})

// End to end against relaycheck's own mock relays: no real API, no real key.
async function withMock(kind, port, fn) {
  const p = spawn(process.execPath, [relaycheckCli(), 'mock', '--kind', kind, '--port', String(port)], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch {} await new Promise((r) => setTimeout(r, 100)) }
    return await fn(`http://127.0.0.1:${port}`)
  } finally { p.kill() }
}

const ref = new URL('../node_modules/relaycheck/refs/mock-honest.json', import.meta.url).pathname

for (const [kind, port, verdict] of [['honest', 18787, 'consistent'], ['swap', 18788, 'inconsistent']]) {
  test(`e2e: ${kind} mock relay is ${verdict}`, { skip: !existsSync(ref) && 'relaycheck refs missing', timeout: 120000 }, () => withMock(kind, port, async (url) => {
    const c = new Schema(Config)({ samples: 24, targets: { mock: { baseUrl: url, model: 'mock-sonnet', ref, keyEnv: 'TEST_RELAY_KEY' } } })
    const tool = createTool(c, { env: { ...process.env, TEST_RELAY_KEY: 'sk-demo-not-a-real-key' } })
    const value = await tool.execute({ target: 'mock' }, { signal: new AbortController().signal })
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [])
    assert.equal(value.verdict, verdict)
    assert.equal(value.host, `127.0.0.1:${port}`)
    assert.ok(value.groups.length >= 3)
    assert.ok(!JSON.stringify(value).includes('sk-demo'))
  }))
}

test('abort kills the run', { timeout: 60000 }, () => withMock('honest', 18789, async (url) => {
  const c = new Schema(Config)({ samples: 200, targets: { mock: { baseUrl: url, model: 'mock-sonnet', ref } } })
  const tool = createTool(c, { env: { ...process.env, RELAY_KEY: 'sk-x' } })
  const ac = new AbortController()
  setTimeout(() => ac.abort(new Error('stop')), 300)
  await assert.rejects(tool.execute({ target: 'mock' }, { signal: ac.signal }), /stop/)
}))
