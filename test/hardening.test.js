// Edge cases and failure paths. Everything runs against local fakes or local HTTP servers:
// no real relay, no real API key (all keys below are made-up test strings).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../src/index.js'
import { Config, OUTPUT_SCHEMA, TOOL_NAME, buildArgv, createTool, hostOf, keyEnvOf, redactDeep, relaycheckCli, render, resolveTarget, runCli, summarize } from '../src/index.js'

const FAKE_KEY = 'sk-test-ZZfakeKey0987654321'
const parse = (c) => new Schema(Config)(c)
const one = (target = {}, over = {}) => parse({ targets: { t: { baseUrl: 'http://127.0.0.1:9', model: 'm', ...target } }, ...over })
const META = { id: 't', host: 'h', model: 'm', api: 'auto', exitCode: 0, durationMs: 5 }
const GOOD = { verdict: 'consistent', headline: 'ok', calibrated: true, usage: { inputTokens: 1, outputTokens: 2, requests: 3 }, durationMs: 10, groups: [] }

/** A fake runCli that writes `report` where relaycheck would have written its --json file. */
const writesReport = (report, extra = {}) => async (argv) => {
  await writeFile(argv[argv.indexOf('--json') + 1], typeof report === 'string' ? report : JSON.stringify(report))
  return { code: 0, stderr: '', ...extra }
}

/** Start a local HTTP server on an ephemeral port. */
async function serve(handler) {
  const server = createServer(handler)
  const sockets = new Set()
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r) }),
  }
}

/** Run fn against a live tool whose key env holds FAKE_KEY. */
const liveTool = (config) => createTool(config, { env: { ...process.env, TEST_RELAY_KEY: FAKE_KEY } })
const errorOf = (p) => p.then(() => assert.fail('should throw'), (e) => e)

// ---------- config schema ----------

test('config schema rejects bad shapes', () => {
  assert.throws(() => parse({ targets: { t: { model: 'm' } } }), /baseUrl/)
  assert.throws(() => parse({ targets: { t: { baseUrl: 'http://x', api: 'grpc' } } }))
  assert.throws(() => parse({ samples: 0 }))
  assert.throws(() => parse({ samples: 201 }))
  assert.throws(() => parse({ samples: 2.5 }))
  assert.throws(() => parse({ lang: 'fr' }))
  assert.throws(() => parse({ timeoutSeconds: 5 }))
  assert.throws(() => parse({ allowDeep: 'yes' }))
})

test('config defaults are complete', () => {
  const c = parse({})
  assert.deepEqual(c.targets, {})
  assert.equal(c.probes, 'identity,protocol,billing,context')
  assert.equal(c.lang, 'en')
  assert.equal(c.timeoutSeconds, 600)
  assert.equal(one().targets.t.api, 'auto')
})

// ---------- target resolution ----------

test('target names that are Object.prototype keys are unknown, not inherited', () => {
  const c = parse({ targets: { a: { baseUrl: 'http://a', model: 'm' }, b: { baseUrl: 'http://b', model: 'm' } } })
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => resolveTarget(c, { target: name }), /unknown target/, name)
  }
  const d = parse({ defaultTarget: 'toString', targets: c.targets })
  assert.throws(() => resolveTarget(d, {}), /no target matches/)
})

test('target resolution: defaultTarget, single target, explicit model wins, session model only for same provider', () => {
  const c = parse({ defaultTarget: 'b', targets: { a: { baseUrl: 'http://a', provider: 'pa' }, b: { baseUrl: 'http://b', model: 'mb' } } })
  assert.equal(resolveTarget(c, {}).id, 'b')
  assert.equal(resolveTarget(c, {}, { provider: 'other', model: 'x' }).id, 'b')
  assert.equal(resolveTarget(c, { target: 'b', model: 'override' }).model, 'override')
  assert.throws(() => resolveTarget(c, { target: 'a' }, { provider: 'other', model: 'x' }), /has no model/)
  assert.equal(resolveTarget(one(), {}).id, 't')
})

// ---------- key env ----------

test('keyEnv must be a real variable name; empty or prototype names do not count as set', async () => {
  assert.throws(() => keyEnvOf({ keyEnv: '' }), /not an environment variable name/)
  assert.throws(() => keyEnvOf({ keyEnv: 'A B' }), /not an environment variable name/)
  assert.throws(() => keyEnvOf({ keyEnv: '1ABC' }), /not an environment variable name/)
  assert.equal(keyEnvOf({}), 'RELAY_KEY')
  const never = () => assert.fail('must not run relaycheck')
  await assert.rejects(createTool(one({ keyEnv: '' }), { cli: 'x', env: {}, runCli: never }).execute({}, {}), /not an environment variable name/)
  for (const name of ['constructor', '__proto__', 'toString']) {
    await assert.rejects(createTool(one({ keyEnv: name }), { cli: 'x', env: {}, runCli: never }).execute({}, {}), new RegExp(`${name} is not set`), name)
  }
})

test('an empty key env var counts as missing', async () => {
  const tool = createTool(one(), { cli: 'x', env: { RELAY_KEY: '' }, runCli: () => assert.fail('must not run') })
  await assert.rejects(tool.execute({}, {}), /RELAY_KEY is not set/)
})

// ---------- base URL ----------

test('bad base URLs fail before relaycheck runs', async () => {
  assert.equal(hostOf('https://relay.example.com:8443/v1'), 'relay.example.com:8443')
  assert.equal(hostOf('http://user:pw@relay.example.com'), 'relay.example.com')
  for (const [url, re] of [['relay.example.com', /not a valid URL/], ['not a url', /not a valid URL/], ['ftp://relay.example.com', /must use http or https/], ['file:///etc/passwd', /must use http or https/]]) {
    const tool = createTool(one({ baseUrl: url }), { cli: 'x', env: { RELAY_KEY: FAKE_KEY }, runCli: () => assert.fail('must not run') })
    await assert.rejects(tool.execute({}, {}), re, url)
  }
})

// ---------- argv ----------

test('argv: values stay values; probes/model/lang/samples/ref are passed through', () => {
  const c = one({ ref: '/refs/x.json', api: 'openai' }, { samples: 7, lang: 'zh' })
  const argv = buildArgv('cli.js', c.targets.t, '--deep', c, { probes: 'identity' }, '/w/r.json')
  assert.equal(argv[argv.indexOf('--model') + 1], '--deep')
  assert.ok(!argv.slice(argv.indexOf('--model') + 2).includes('--deep'), 'a model value must not turn into a flag')
  assert.equal(argv[argv.indexOf('--probes') + 1], 'identity')
  assert.equal(argv[argv.indexOf('--samples') + 1], '7')
  assert.equal(argv[argv.indexOf('--lang') + 1], 'zh')
  assert.equal(argv[argv.indexOf('--api') + 1], 'openai')
  assert.equal(argv[argv.indexOf('--ref') + 1], '/refs/x.json')
  assert.equal(argv[argv.indexOf('--json') + 1], '/w/r.json')
  assert.ok(!buildArgv('cli.js', c.targets.t, 'm', c, { deep: false }, 'x').includes('--deep'))
})

test('e2e: a flag-shaped model value is refused by relaycheck, not obeyed', { timeout: 30000 }, async () => {
  const c = one({ keyEnv: 'TEST_RELAY_KEY' })
  const err = await errorOf(liveTool(c).execute({ model: '--deep' }, {}))
  assert.match(err.message, /relaycheck failed \(exit 3\).*--model requires a value/)
})

// ---------- malformed reports ----------

test('malformed relaycheck reports give a model-readable error, not a TypeError', async () => {
  for (const bad of ['not json', 'null', '[]', '"str"', '{}', JSON.stringify({ verdict: 'great' })]) {
    const tool = createTool(one(), { cli: 'x', env: { RELAY_KEY: FAKE_KEY }, runCli: writesReport(bad) })
    const err = await errorOf(tool.execute({}, {}))
    assert.ok(!(err instanceof TypeError), `${bad}: ${err}`)
    assert.match(err.message, /relaycheck (failed|wrote a report without a valid verdict)/, bad)
  }
})

test('summarize tolerates junk fields and always conforms to the output schema', () => {
  const junk = [
    { ...GOOD, groups: { not: 'an array' } },
    { ...GOOD, groups: [null, 3, 'x', { id: 'identity', status: 'pass', summary: 42 }] },
    { ...GOOD, usage: { inputTokens: '12', outputTokens: NaN, requests: Infinity } },
    { ...GOOD, usage: null, durationMs: 'slow', injectedTokens: NaN, pValue: NaN },
    { ...GOOD, injectedTokens: Infinity, pValue: -Infinity, headline: { de: 'nur deutsch' } },
    { ...GOOD, headline: null, calibrated: 'yes', target: null },
    { verdict: 'inconclusive' },
  ]
  for (const r of junk) {
    const v = summarize(r, META, 'en')
    assert.deepEqual(validateJsonSchemaValue(OUTPUT_SCHEMA, v), [], JSON.stringify(r))
    assert.equal(typeof render(v)[0].text, 'string')
  }
  const v = summarize({ ...GOOD, usage: { inputTokens: 12.9, outputTokens: 3, requests: 1 }, injectedTokens: 511.7, pValue: 0.2 }, META, 'en')
  assert.deepEqual(v.usage, { inputTokens: 12, outputTokens: 3, requests: 1 })
  assert.equal(v.injectedTokens, 511)
  assert.equal(v.pValue, 0.2)
  assert.equal(summarize({ verdict: 'consistent' }, META, 'en').durationMs, 5, 'falls back to the measured duration')
})

test('summarize picks the language and falls back to en', () => {
  const r = { ...GOOD, headline: { en: 'E', zh: 'Z' }, groups: [{ id: 'g', status: 's', summary: { en: 'only en' } }] }
  assert.equal(summarize(r, META, 'zh').headline, 'Z')
  assert.equal(summarize(r, META, 'zh').groups[0].summary, 'only en')
})

test('render: optional lines appear only when present', () => {
  const base = summarize(GOOD, META, 'en')
  const text = render(base)[0].text
  assert.ok(!/p-value/.test(text) && !/inject/.test(text))
  const rich = render(summarize({ ...GOOD, pValue: 0.000123, calibrated: false, injectedTokens: 512 }, META, 'en'))[0].text
  assert.match(rich, /identity p-value: 0\.000123 \(uncalibrated reference\)/)
  assert.match(rich, /about 512 hidden prompt tokens/)
})

// ---------- schemas ----------

/** dsh rejects JSON-Schema type arrays; check every node explicitly as well. */
function walkTypes(node, path, out) {
  if (!node || typeof node !== 'object') return
  if ('type' in node && typeof node.type !== 'string') out.push(path)
  for (const [k, v] of Object.entries(node.properties ?? {})) walkTypes(v, `${path}.${k}`, out)
  if (node.items) walkTypes(node.items, `${path}[]`, out)
  return out
}

test('output and parameter schemas are dsh-valid and have no type arrays, with and without targets', () => {
  for (const c of [one(), parse({})]) {
    const tool = createTool(c, { cli: 'x' })
    assertObjectJsonSchema(tool.output.schema)
    assertSupportedJsonSchema(tool.parameters)
    assertObjectJsonSchema(tool.parameters)
    assert.deepEqual(walkTypes(tool.output.schema, '$', []), [])
    assert.deepEqual(walkTypes(tool.parameters, '$', []), [])
  }
  assert.equal(createTool(parse({}), { cli: 'x' }).parameters.properties.target.enum, undefined, 'no empty enum when no targets')
  assert.ok(Number.isFinite(createTool(one(), { cli: 'x' }).timeoutMs))
})

// ---------- key never leaks ----------

test('key is redacted from the result value, even if the report echoes it', async () => {
  const report = { ...GOOD, headline: `relay said ${FAKE_KEY}`, groups: [{ id: 'protocol', status: 'warn', summary: { en: `Bearer ${FAKE_KEY}` } }] }
  const tool = createTool(one(), { cli: 'x', env: { RELAY_KEY: FAKE_KEY }, runCli: writesReport(report) })
  const v = await tool.execute({}, {})
  assert.ok(!JSON.stringify(v).includes(FAKE_KEY))
  assert.ok(!render(v)[0].text.includes(FAKE_KEY))
  assert.deepEqual(validateJsonSchemaValue(OUTPUT_SCHEMA, v), [])
})

test('redactDeep covers nested strings and leaves other values alone', () => {
  assert.deepEqual(redactDeep({ a: ['x k y', { b: 'k' }], n: 1, z: null }, 'k'), { a: ['x *** y', { b: '***' }], n: 1, z: null })
  assert.equal(redactDeep('abc', ''), 'abc')
})

test('runCli redacts stderr before truncating, so no fragment of the key survives', async () => {
  // 5000 filler bytes push the key across the 4000-byte truncation boundary.
  const script = `process.stderr.write('k=' + process.env.K + 'x'.repeat(3990 - process.env.K.length) + '\\nend ' + process.env.K + '\\n')`
  const { stderr } = await runCli(['-e', script], { timeoutMs: 10000, env: { ...process.env, K: FAKE_KEY }, redact: (s) => s.replaceAll(FAKE_KEY, '***') })
  for (let n = 6; n <= FAKE_KEY.length; n++) assert.ok(!stderr.includes(FAKE_KEY.slice(-n)), `suffix of length ${n} leaked`)
  assert.match(stderr, /end \*\*\*/)
})

test('e2e: relay that echoes the Authorization header does not leak the key', { timeout: 60000 }, async () => {
  const srv = await serve((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `invalid key ${req.headers.authorization ?? req.headers['x-api-key']}` } }))
  })
  try {
    const err = await errorOf(liveTool(one({ baseUrl: srv.url, keyEnv: 'TEST_RELAY_KEY', api: 'openai' })).execute({}, {}))
    assert.match(err.message, /relaycheck failed \(exit 3\)/)
    assert.ok(!err.message.includes(FAKE_KEY), err.message)
    assert.ok(!err.message.includes('ZZfakeKey'), err.message)
  } finally { await srv.close() }
})

// ---------- network failures ----------

test('e2e: connection refused surfaces as a readable relaycheck failure', { timeout: 60000 }, async () => {
  const srv = await serve(() => {})
  const url = srv.url
  await srv.close() // nothing listens on this port any more
  const err = await errorOf(liveTool(one({ baseUrl: url, keyEnv: 'TEST_RELAY_KEY', api: 'openai' })).execute({}, {}))
  assert.match(err.message, /relaycheck failed \(exit 3\).*preflight request failed/)
})

test('e2e: malformed relay responses (200 with non-JSON body) fail cleanly', { timeout: 60000 }, async () => {
  const srv = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('<html>definitely not json') })
  try {
    const err = await errorOf(liveTool(one({ baseUrl: srv.url, keyEnv: 'TEST_RELAY_KEY', api: 'anthropic' })).execute({}, {}))
    assert.match(err.message, /relaycheck failed \(exit 3\)/)
  } finally { await srv.close() }
})

test('e2e: a relay that never answers is killed at timeoutSeconds and reported as a timeout', { timeout: 60000 }, async () => {
  const srv = await serve(() => { /* hang */ })
  try {
    const c = one({ baseUrl: srv.url, keyEnv: 'TEST_RELAY_KEY', api: 'openai' })
    c.timeoutSeconds = 1 // below the config minimum, only to keep the test short
    const t0 = Date.now()
    const err = await errorOf(liveTool(c).execute({}, {}))
    assert.match(err.message, /relaycheck timed out after 1s/)
    assert.ok(Date.now() - t0 < 15000)
  } finally { await srv.close() }
})

test('runCli: timeout kills the child and says so', { timeout: 20000 }, async () => {
  const r = await runCli(['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 })
  assert.equal(r.timedOut, true)
  assert.equal(r.signal, 'SIGTERM')
  assert.equal(r.code, 3)
  const ok = await runCli(['-e', 'process.exitCode = 1'], { timeoutMs: 5000 })
  assert.deepEqual([ok.code, ok.timedOut], [1, false])
})

test('runCli: a timeout beyond the 32-bit timer range does not fire at once', { timeout: 20000 }, async () => {
  const r = await runCli(['-e', 'setTimeout(() => {}, 300)'], { timeoutMs: 2 ** 31 + 5 })
  assert.deepEqual([r.code, r.timedOut, r.signal], [0, false, null])
})

test('runCli: an already-aborted signal rejects without spawning', async () => {
  const ac = new AbortController()
  ac.abort(new Error('pre-aborted'))
  const t0 = Date.now()
  // execPath does not exist: if runCli spawned anyway it would fail with ENOENT, not our reason.
  await assert.rejects(runCli(['-e', '1'], { signal: ac.signal, timeoutMs: 5000, execPath: '/nonexistent/node' }), /pre-aborted/)
  assert.ok(Date.now() - t0 < 500)
})

test('execute: an already-aborted call never runs relaycheck', async () => {
  const ac = new AbortController()
  ac.abort(new Error('user cancelled'))
  const tool = createTool(one(), { cli: 'x', env: { RELAY_KEY: FAKE_KEY }, runCli: () => assert.fail('must not run') })
  await assert.rejects(tool.execute({}, { signal: ac.signal }), /user cancelled/)
})

test('runCli: spawn failure rejects', async () => {
  await assert.rejects(runCli(['x'], { timeoutMs: 1000, execPath: '/nonexistent/node' }), /ENOENT/)
})

// ---------- billing injection (relaycheck's inject mock) ----------

const ref = new URL('../node_modules/relaycheck/refs/mock-honest.json', import.meta.url).pathname

test('e2e: inject mock relay reports hidden tokens', { skip: !existsSync(ref) && 'relaycheck refs missing', timeout: 60000 }, async () => {
  const p = spawn(process.execPath, [relaycheckCli(), 'mock', '--kind', 'inject', '--port', '18790'], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:18790/health')).ok) break } catch {} await new Promise((r) => setTimeout(r, 100)) }
    const c = one({ baseUrl: 'http://127.0.0.1:18790', model: 'mock-sonnet', ref, keyEnv: 'TEST_RELAY_KEY', api: 'anthropic' })
    const v = await liveTool(c).execute({ probes: 'billing' }, {})
    assert.deepEqual(validateJsonSchemaValue(OUTPUT_SCHEMA, v), [])
    assert.equal(v.verdict, 'inconsistent')
    assert.equal(v.exitCode, 1)
    assert.equal(v.injectedTokens, 512)
    assert.deepEqual(v.groups.map((g) => g.id), ['billing'])
    assert.match(render(v)[0].text, /512 hidden prompt tokens/)
  } finally { p.kill() }
})

// ---------- plugin lifecycle in a real cordis context ----------

async function host() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}
const gate = (ctx, name) => ctx.waterfall(ctx, 'tools/pre-execute', { name }, () => Promise.resolve({ kind: 'allow' }))

test('plugin: registers in dsh-tools, gates approval, and disposes cleanly', async () => {
  const ctx = await host()
  const fiber = ctx.plugin(plugin, { targets: { t: { baseUrl: 'http://127.0.0.1:9', model: 'm' } } })
  await fiber
  assert.ok(ctx.tools.get(TOOL_NAME))
  assert.equal((await gate(ctx, TOOL_NAME)).kind, 'ask')
  assert.equal((await gate(ctx, 'bash')).kind, 'allow')
  await fiber.dispose()
  assert.ok(!ctx.tools.get(TOOL_NAME), 'tool unregistered on dispose')
  assert.equal((await gate(ctx, TOOL_NAME)).kind, 'allow', 'approval hook removed on dispose')
})

test('plugin: requireApproval false registers no gate; invalid config is refused', async () => {
  const ctx = await host()
  const fiber = ctx.plugin(plugin, { requireApproval: false, targets: { t: { baseUrl: 'http://127.0.0.1:9', model: 'm' } } })
  await fiber
  assert.equal((await gate(ctx, TOOL_NAME)).kind, 'allow')
  await fiber.dispose()
  await assert.rejects(async () => { await ctx.plugin(plugin, { targets: { t: { model: 'm' } } }) }, /baseUrl/)
})

test('plugin: disposing aborts a run still in flight', { timeout: 60000 }, async () => {
  const srv = await serve(() => { /* hang */ })
  const ctx = await host()
  const saved = process.env.TEST_RELAY_KEY
  process.env.TEST_RELAY_KEY = FAKE_KEY
  try {
    const fiber = ctx.plugin(plugin, { requireApproval: false, targets: { t: { baseUrl: srv.url, model: 'm', api: 'openai', keyEnv: 'TEST_RELAY_KEY' } } })
    await fiber
    const run = ctx.tools.get(TOOL_NAME).execute({}, { signal: new AbortController().signal })
    await new Promise((r) => setTimeout(r, 500))
    const t0 = Date.now()
    await fiber.dispose()
    await assert.rejects(run, /disposed/)
    assert.ok(Date.now() - t0 < 5000)
  } finally {
    if (saved === undefined) delete process.env.TEST_RELAY_KEY
    else process.env.TEST_RELAY_KEY = saved
    await srv.close()
  }
})
