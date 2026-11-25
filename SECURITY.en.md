# Security Policy

## Supported versions

| Version | Receives security fixes |
| --- | --- |
| `2.x` (the currently maintained line, starting from `2.0.0`) | Yes |
| `1.x` and earlier | No — please upgrade to the latest supported version first |

Only the `2.x` line is currently maintained. Issues in older versions that still exist in the new version are fixed there; no separate patches are released for old versions.

## Private reporting

**Do not open a public issue, PR or discussion for a security vulnerability**, and do not post exploitable details in public channels. Use either of these private routes:

1. GitHub Security Advisories (preferred): <https://github.com/pengtang1024/dsh-smart-provider/security/advisories/new>
2. Email: <pengtang1024@qq.com>, preferably with `[SECURITY]` in the subject line.

Please include as much of the following as you can in your report:

- The affected specific `2.x` version.
- Reproduction steps or a minimal PoC.
- The actual impact (e.g. whether the cost ledger can be read, configuration tampered with, or routing influenced).
- If convenient, a suggested fix.

## Response timeline

- **Within 3 business days**: acknowledge the report and give an initial assessment.
- Once confirmed as a valid issue, we will outline a fix plan; after the fix is released, the GitHub Security Advisory will record the affected and fixed versions.
- If the report is judged out of scope, we will explain why and point you to the appropriate upstream channel.

## Scope

This repository is responsible for security issues in **the plugin itself**:

- The `smart` meta-provider registered by `lib/adapter.js`, and the routing, failover and account-ranking logic in `lib/chains.js`, `lib/routing.js` and `lib/ranking.js`;
- The account pool, cooldown and availability state in `lib/account-pool.js`, `lib/account-health.js` and `lib/availability.js`;
- Self-built custom routes declared in `registry/custom-routes.user.yaml`, and the read/write and validation performed by `scripts/gen-custom-routes.mjs` and `scripts/validate-custom-routes.mjs`;
- The cost JSONL ledger written by `lib/cost-meter.js`, aggregated by `lib/cost-stats.js` and queried by `scripts/query-cost.mjs`;
- The settings page injected by `client.js` via `window.__ModuleLoader__.load` into `settings.section` / `settings.section.icon`, and the `smartProvider` `@Remote` service exposed by `lib/remote.js`;
- The plugin entry `index.js`, the configuration schema `schema.js`, and the bundled bundle descriptor file.

**Out of scope for this repository**: DSH itself (including `llm-pi-ai` provider routes and credential storage), the plugin loader, the renderer sandbox, web services, host built-in components and upstream model services. Please route such issues through the official DeepSeek Harness channels:

- <https://github.com/deepseek-ai/deepseek-harness/security>
- Or any other security reporting entry published by that repository / official site.

`package.json` declares no npm dependency list; the Dependabot npm entry is currently a no-op, while the github-actions entry checks Actions updates weekly. The settings client `client.js` only requires host-provided `react`, `zod` and `@deepseek-ai/dsh-client-ui-primitives`; the Host side uses `@deepseek-ai/dsh-typert-protocol` and the Cordis service framework from the host environment. Scripts under `scripts/` run only during development, use Node built-in modules to read and write repository and local data files, and do not ship into the browser.

## Security design notes

- **Real keys never enter plugin configuration.** Real API keys always stay in DSH credentials. This plugin's configuration, `registry/custom-routes.user.yaml` and the settings page contain only `credentialRef`-style **reference names**, never plaintext keys. `scripts/validate-custom-routes.mjs` reads only the key names from the credentials file for an existence check; it never reads or prints their values.
- **The settings page does not call model services directly.** `client.js` contains no `fetch`, `XMLHttpRequest`, `WebSocket`, `eval`, `new Function`, `innerHTML` or `dangerouslySetInnerHTML`; the UI is built entirely with `React.createElement`. Model probing can only be triggered on the Host side by `lib/probe.js`, with one tiny request (`max_tokens≈1`) per candidate, a TTL cache and a per-call cap; it requires an explicit user action and never probes `smart` itself.
- **The cost ledger is written locally.** Each completed hop is asynchronously appended as a line to `cost.jsonl` (by default under `~/.dsh/smart-provider/`, with a configurable directory), recording tokens, estimated cost, provider/model, `accountId` and failure code; writes do not block the LLM stream, and disk errors are logged only as WARN. Before writing, `sanitizeFailureMessage()` masks Bearer / api-key / token-shaped substrings and truncates to 300 characters so an upstream error body cannot carry secrets or large payloads into the ledger. Prices come from the read-only exported `lib/pricing.json` and are offline estimates of public list prices, not billing statements.
- **Configuration takes effect immediately but does not escalate privileges.** `chains`, `accounts` and `ranking.routing` are volatile settings that apply as soon as they are saved in the settings page; summary / cost / health data is read from the real ledger and registry through `@Remote` services. The plugin works only through DSH-provided slots and services and does not bypass the host's permissions and approval mechanisms.

## Known boundaries

- `cost.jsonl` is a plaintext local JSONL file: it contains token usage, estimated cost, account reference names and sanitized diagnostic text. It holds **no real keys, but should still be treated as sensitive** — do not publish raw ledgers.
- `registry/custom-routes.user.yaml` is the single manual edit point for custom routes. Only write a `credentialRef` reference name there; **never paste a plaintext key into YAML, an issue or a conversation**.
- The plugin is installed as a local-directory bundle; installation loads `client.js` and the Host entry. Install only from this repository or a source you trust, never a modified package of unknown origin.
- Cost and availability conclusions depend on your real configuration, runtime registry and ledger. Route and model names in the documentation are examples only; the repository does not ship any particular account or endpoint.
