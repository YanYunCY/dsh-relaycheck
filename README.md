# dsh-relaycheck

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent a `relay_check` tool: ask it "is this relay really serving the model it claims?" and it runs [relaycheck](https://github.com/YanYunCY/relaycheck) against the relay and reports a verdict.

中文：给 dsh 的 agent 加一个 `relay_check` 工具，用 [relaycheck](https://github.com/YanYunCY/relaycheck) 检测 LLM API 中转是否货真价实（模型是否被调包、计费是否虚报、上下文是否被截断、是否注入隐藏提示词）。

## What it checks

relaycheck runs four groups against the relay and compares the answers with a reference fingerprint:

| Group | What it catches |
|---|---|
| identity | model swap: 24 probes × N samples, permutation χ² per probe, Cauchy-combined p-value |
| protocol | wrong or missing protocol fields for the claimed API |
| billing | reported `usage` vs. the real token count; hidden prompt injection |
| context | truncated context window (needle test) |

The verdict is `consistent`, `inconsistent` or `inconclusive`. It is a statistical test, not proof.

## Install

```bash
dsh plugin --profile web add dsh-relaycheck
```

Requires Node ≥ 24.9 (the same as dsh). Tested with dsh 0.2.1-rc.5.

## Configure

The model can only name a **configured target**. Base URLs and key variable names live in your profile config, so a prompt injection cannot point your key at another host. Keys are read from environment variables only.

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: relaycheck
  config:
    targets:
      myrelay:
        baseUrl: https://relay.example.com
        model: claude-sonnet-4-5      # optional; empty = the model of the calling session
        api: auto                     # auto | anthropic | openai | responses
        keyEnv: RELAY_KEY             # name of the env var holding the key
        provider: myrelay             # dsh provider id this relay backs (optional)
    samples: 16
    requireApproval: true             # ask before each run; a run spends relay tokens
    allowDeep: false                  # --deep costs about 100k extra input tokens
```

```bash
export RELAY_KEY=sk-...
dsh web
```

Each `baseUrl` must be an `http://` or `https://` URL and each `keyEnv` a plain variable name (`[A-Za-z_][A-Za-z0-9_]*`); the tool checks both, and that the variable is set and non-empty, before it starts relaycheck, so a misconfigured target costs no tokens.

When `provider` matches the provider of the current session, the agent can call `relay_check` with no arguments to test "the relay I'm using now", with the session's model.

| Option | Default | Meaning |
|---|---|---|
| `targets` | `{}` | named relays the agent may check |
| `defaultTarget` | — | used when the call names none and no provider matches |
| `samples` | `16` | samples per identity probe |
| `probes` | `identity,protocol,billing,context` | groups to run |
| `allowDeep` | `false` | let the agent request `--deep` |
| `requireApproval` | `true` | approval prompt before every run |
| `lang` | `en` | `en` or `zh` for the summaries |
| `timeoutSeconds` | `600` | kill the run after this long (the tool then reports a timeout) |

## The tool

`relay_check({ target?, model?, probes?, deep? })` returns:

```json
{
  "target": "myrelay", "host": "relay.example.com", "model": "claude-sonnet-4-5", "api": "anthropic",
  "verdict": "inconsistent", "headline": "...", "pValue": 0.0003, "calibrated": true,
  "exitCode": 1,
  "groups": [{ "id": "identity", "status": "fail", "summary": "..." }],
  "usage": { "inputTokens": 41200, "outputTokens": 3900, "requests": 412 },
  "durationMs": 95000
}
```

`pValue` and `injectedTokens` are left out when relaycheck reports none. The model sees a short text summary of the same facts.

The key is passed to relaycheck by variable name only, never on the command line. relaycheck redacts it from its own output; the plugin additionally replaces any occurrence of the key's exact value with `***` in the result and in error messages, as a second line of defence.

When a run fails, the tool returns an ordinary error the model can read instead of a result:

- relaycheck exits without a report (unreachable relay, HTTP errors, non-JSON responses, bad arguments): `relaycheck failed (exit N): <last lines of relaycheck's stderr>`
- the run hits `timeoutSeconds`: `relaycheck timed out after Ns`
- the report has no valid `verdict` (for example an incompatible relaycheck version): the tool says so rather than returning a partial result

Cancelling the tool call, or disposing the plugin (profile reload, dsh exit), stops a run in progress.

## Cost

A default run sends a few hundred short requests (24 probes × `samples`, plus protocol, billing and context checks) and takes one to several minutes. That is why `requireApproval` is on by default.

## Development

```bash
npm install
npm test     # no real API, no real key, no network beyond 127.0.0.1
```

The suite covers config validation, target resolution, argv building, malformed reports, key redaction, abort/timeout handling and plugin disposal inside a real cordis + dsh-tools context. End-to-end cases run relaycheck against its own local mock relays (honest, model-swapping, token-injecting) and against small local HTTP servers that refuse connections, hang, return non-JSON, or echo the key back.

## License

MIT
