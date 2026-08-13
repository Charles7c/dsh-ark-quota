# AGENTS.md

Guidance for AI agents (and deep-dive developers) working in this repository.
This file is the machine-actionable counterpart of [CONTRIBUTING.md](./CONTRIBUTING.md):
it exists because most of the "how to touch this code" knowledge here is execution
detail, not human onboarding.

This is a **DeepSeek Harness (DSH) web plugin**: everything runs as a plugin on
Cordis. The host half runs inside the DSH server; the browser half is a
hand-written bundle consumed by the DSH client module loader.

## Repo layout

| path | what it is |
| --- | --- |
| `lib/index.js` | Host half (ESM): registers the `ark-quota` settings namespace + the same-origin `/ark-quota` proxy route. |
| `lib/client.js` | Browser half: shipped client bundle in `window.__ModuleLoader__.load({ id, factory })` format. **No build step — edit this file directly.** |
| `tools/refresh.mjs` | Standalone Node CLI (no DSH imports): pops Edge via CDP, extracts console cookies after login, writes them atomically to `$DSH_HOME/settings.yaml`. |
| `cordis.patch.yml.example` | Example profile entry; only `PASTE_*` placeholders are allowed. |
| `README.md` / `README.zh-CN.md` | User docs — keep bilingual in sync. |

## Load mechanics (know before editing)

- **Plugin-set changes (adding/removing the entry in `cordis.patch.yml`) require a server restart** — the client boot graph is built at startup by the Node half of `dsh-client-modules` (it scans enabled entries for `dsh.client` packages, resolves `exports["./client"]`, hashes and serves the bundle under `/plugins`).
- **Host half changes always require a server restart.** The host does not hot-reload file packages; the dynamic runner only sandboxes inline packages.
- **Client bundle changes hot-reload only with a rebuild watcher**: the HMR chain (`dsh-client-hmr`, browser polls `GET /plugins/events`) stays idle unless `pnpm run dev:web` from a DSH source checkout rewrites the bundle. Without the watcher, editing `lib/client.js` + manual browser refresh is the loop. HMR reload is coarse: React state inside the reloaded plugin is lost.
- The client bundle is lazy: executing the script only registers the factory; the factory body runs at materialization (`factory(require)` → `module.exports` with `apply` + `inject`).

## Conventions — host (`lib/index.js`)

- Register everything through `ctx.effect(fn, label)` (fiber-scoped teardown).
- The settings namespace (`ctx.settings.register(ARK_QUOTA_NS, SettingsSchema, { base })`) is the live-maintenance seam: read the **effective** config from the scope (`scope.get()`), never the static `config`; the `scope.watch` handler must drop the in-memory csrf token and cache so cookie refreshes apply without restart.
- CSRF rotation: on `InvalidCSRFToken`, adopt `X-Need-Token` and retry once (one retry only).
- Validate config with `Config['~standard'].validate(config)` (schemastery implements Standard Schema).
- The route must never echo cookies; accept only fixed-shape inputs (no user-controlled URLs — no SSRF surface).
- Proxy failures map to honest statuses: `unauthorized` → 401, `network` → 504, else 502; HEAD returns no body.

## Conventions — client (`lib/client.js`)

- Keep the loader format exactly: `window.__ModuleLoader__.load({ id: "dsh-ark-quota", factory: (require) => {...} })`.
- `require` only `react` / `react/jsx-runtime` (plus `react-dom` in tests) — the bundle purity gate forbids cross-plugin value imports; collaborate via cordis services.
- Register the widget with `ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name, id, order, label, inject }, Component))` — the slot is shell-declared; `slots.inject` waits for the declaration.
- Bind settings with `ctx.settingsScope.bind({ namespace: "ark-quota" })` and expose it through the registration `inject` → `hooks` face; refetch when the settings revision changes.
- Render everything through React elements/attributes (React escapes). **Never** `dangerouslySetInnerHTML` / `innerHTML` with console-derived strings.
- Look up level labels with `Object.prototype.hasOwnProperty.call(...)`, never bare `obj[key] || fallback` (prototype keys).

## Conventions — tools (`tools/refresh.mjs`)

- Bind the CDP port to `127.0.0.1` only (`--remote-debugging-address=127.0.0.1`).
- Tear down on **every** exit path: graceful `Browser.close`, fallback `taskkill /T /F`, `rm` of the throwaway profile, SIGINT/SIGTERM handlers, try/finally.
- Write `settings.yaml` atomically (temp file + `rename`).
- Never print full cookie values — truncate (`slice(0,12) + "…" + slice(-8)`).
- Match cookie domains with `endsWith(".volcengine.com")`, not `includes`.

## Security invariants (MANDATORY)

This plugin moves **real session credentials** (Volcano Ark console cookies: `userInfo`/`digest` JWTs, `csrfToken`). Treat them as passwords.

1. Never commit real cookies/tokens/keys — any file, any commit, any branch. `PASTE_*` placeholders only in docs/examples.
2. Never log full cookie values.
3. Never echo cookies in HTTP responses.
4. `.gitignore` is the last line of defense (`settings.yaml`, `cordis.patch.yml`, `.dsh/`, `.env`, `.npmrc`); ignore any new file that could hold credentials.
5. The CDP tool runs a browser holding a live session: loopback-only, short-lived, cleaned up on every path. Never turn it into a long-running service.
6. Before any push, run the secret scan:

   ```sh
   grep -rInE 'eyJhbGciOi|ark-[A-Za-z0-9]{20,}|gho_|ghp_|github_pat_|AKLT|Bearer [A-Za-z0-9._-]{20,}' .
   ```

   Output must contain no real values (code references like `csrfToken` field names and `PASTE_*` are acceptable).

## Testing (no framework — plain Node scripts)

1. Syntax: `node --check lib/index.js lib/client.js tools/refresh.mjs`.
2. Host smoke test (mock `ctx` with `webServer`/`settings`/`effect`/`logger`, no server): namespace registers with patch config as base; `scope.get()` drives effective config; a settings change (watch callback) makes the next request carry the new cookies; broken cookies → `401` + `ok:false`; HEAD → no body.
3. Client render smoke test: load the bundle under a `window.__ModuleLoader__` stub, `apply` with mock `slots`/`settingsScope`, SSR with `react-dom/server` (wide + rail).
4. End-to-end: restart DSH → `curl http://127.0.0.1:3080/ark-quota?force=1` returns fresh quota → widget renders in the sidebar footer → run `tools/refresh.mjs` once and confirm the widget updates without restart.

## Release gate

Before tagging a release: full testing checklist + secret scan + **pro-model security review of the diff** (secret leakage, proxy SSRF/header injection, widget XSS, refresh-tool lifecycle). Then:

```sh
git tag vX.Y.Z
git push origin main --tags
gh release create vX.Y.Z --generate-notes
```

## Reference docs

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — official repo; see its [AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md) for agent conventions upstream.
- `@deepseek-ai/dsh-client-modules` — boot graph, `/plugins` serving, lazy `__ModuleLoader__` factory model.
- `@deepseek-ai/dsh-client-hmr` — `GET /plugins/events` reload chain, `pnpm run dev:web` watcher requirement.
- `@deepseek-ai/dsh-client-ui-slots` — slot registration contract.
- `@deepseek-ai/dsh-client-runtime` — `ctx.slots.inject` declaration injection, `bindSettingsScope`.
- `@deepseek-ai/dsh-settings` / `dsh-settings-file` — host settings registry, hot-reloaded `settings.yaml`.
- [Cordis](https://github.com/cordiverse/cordis) — the plugin framework everything runs on.
