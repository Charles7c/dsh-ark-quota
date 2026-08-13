# Contributing to dsh-ark-quota

English | [简体中文](./CONTRIBUTING.zh-CN.md)

Thank you for your interest in contributing to `dsh-ark-quota`! This plugin is part of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ecosystem, where **everything is a plugin** (powered by [Cordis](https://github.com/cordiverse/cordis)). The DeepSeek Harness core does not accept external pull requests right now, but **community plugins are the officially encouraged way to extend it** — giving this project a `dsh-plugin` GitHub topic is exactly how the ecosystem discovers each other.

> ⚠️ DeepSeek Harness is in **developer preview** and iterates rapidly — there will be compatibility-breaking changes. Pin the DSH version you develop against and re-test on upgrade.

## Repository layout

| path | what it is |
| --- | --- |
| `lib/index.js` | Host half: registers the `ark-quota` settings namespace and the same-origin `/ark-quota` proxy route (`ctx.webServer.register`). |
| `lib/client.js` | Browser half: the client bundle, hand-written in the exact loader format (`window.__ModuleLoader__.load({ id, factory })`), registers the `sidebar.footer.action` widget via `ctx.slots.inject` / `ctx.slots.register`. |
| `tools/refresh.mjs` | Standalone Node CLI: pops Edge (CDP, loopback-only), extracts session cookies after login, writes them atomically into `$DSH_HOME/settings.yaml`. |
| `cordis.patch.yml.example` | Example profile entry with `PASTE_*` placeholders. |

There is **no build step** in this repository: the client bundle is authored directly in the format the DSH client module loader consumes, and the host half is plain ESM. Keeping it build-free is a deliberate design decision — see [Development workflow](#development-workflow).

## Development setup

### Prerequisites

- Node.js ≥ 22 (global `fetch`, `WebSocket`, `AbortSignal.timeout`)
- A DeepSeek Harness web profile (`dsh web`, default port `127.0.0.1:3080`)
- `pnpm` (only if you plan to run the DSH dev watcher; the plugin itself has no install step)

### Running the plugin locally

The simplest loop: clone (or symlink) this repo into your profile's workspace and point the workspace at it:

```yaml
# $DSH_HOME/profiles/<profile>/pnpm-workspace.yaml
packages:
  - .
  - 'node_modules/dsh-ark-quota'   # or a path/symlink to your checkout
```

then add the entry to `cordis.patch.yml` (see `cordis.patch.yml.example`), start `npx @deepseek-ai/dsh web`, and open `http://127.0.0.1:3080`.

### How the plugin loads (read this before editing)

- The **Node half** of `@deepseek-ai/dsh-client-modules` scans enabled Loader entries for web `dsh.client` packages, resolves each `exports["./client"]`, hashes the bundle into the boot graph, and serves it under `/plugins`. **Changing the plugin set (adding/removing the entry) requires a server restart** — the boot graph is built at startup.
- The **client bundle** is loaded lazily: executing the script only registers the factory (`window.__ModuleLoader__.load`); the factory body runs at materialization (`factory(require)` → `module.exports` with `apply` + `inject`).
- **Host half changes always require a server restart** (the host does not hot-reload file packages; the dynamic runner is a sandbox for inline packages only).
- **Client bundle changes can hot-reload** via `@deepseek-ai/dsh-client-hmr`: the browser polls `GET /plugins/events` and reloads one plugin per `rebuilt` frame. But the HMR chain stays idle unless a rebuild watcher rewrites the bundle — i.e. you must run `pnpm run dev:web` from a DSH source checkout that watches this package. Without the watcher, a manual refresh (F5) after editing `lib/client.js` is the working loop. The HMR reload is coarse: React state inside the reloaded plugin is lost.

## Development workflow

### Editing the host (`lib/index.js`)

1. Make the change.
2. Verify the config schema still validates: `Config['~standard'].validate(config)` (schemastery implements the Standard Schema interface).
3. Run the host smoke test pattern (see [Testing](#testing)) with a mock `ctx` (`webServer`, `settings`, `effect`, `logger`).
4. Restart DSH and verify `GET /ark-quota` end-to-end.

Conventions:

- Register everything through `ctx.effect(fn, label)` so teardown is fiber-scoped.
- Keep the settings namespace registration (`ctx.settings.register(ARK_QUOTA_NS, SettingsSchema, { base })`) — it is the live-maintenance seam; read the *effective* config from the scope (`scope.get()`), not from the static `config`.
- Any settings change must drop the in-memory csrf token and cache (the `scope.watch` handler).
- The route must never echo cookies, and must only accept fixed-shape inputs (no user-controlled URLs).

### Editing the client (`lib/client.js`)

This file is the shipped bundle — write it in the exact loader format:

```js
window.__ModuleLoader__.load({
  id: "dsh-ark-quota",
  factory: (require) => {
    // require("react") / require("react/jsx-runtime") only — the bundle purity
    // gate forbids cross-plugin value imports; collaborate via cordis services.
    function apply(ctx) { /* slots.inject / slots.register ... */ }
    return { apply, inject: ["slots", "settingsScope"] };
  }
});
```

Conventions:

- Register the widget with `ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name, id, order, label, inject }, Component))` — the slot is declared by the shell; `slots.inject` waits for the declaration so activation order does not matter.
- Bind the settings namespace with `ctx.settingsScope.bind({ namespace: "ark-quota" })` and expose it through the registration's `inject` → `hooks` face; the widget refetches when the settings revision changes.
- Render everything through React elements/attributes (React escapes); **never** use `dangerouslySetInnerHTML` or `innerHTML` with console-derived strings.
- Keep the bundle dependency-free apart from `react` / `react/jsx-runtime` / `react-dom` (test-only) — mirror the bundle purity gate manually.
- After editing, re-run the client render smoke test (SSR with `react-dom/server`).

### Editing `tools/refresh.mjs`

It is a standalone Node CLI (no DSH imports). Security invariants to preserve:

- Bind the CDP port to `127.0.0.1` only.
- Tear down on **every** exit path: graceful `Browser.close`, fallback `taskkill /T /F`, `rm` of the throwaway profile, SIGINT/SIGTERM handlers, try/finally.
- Write `settings.yaml` atomically (temp file + `rename`).
- Never print full cookie values — truncate (`slice(0,12) + "…" + slice(-8)`).
- Match cookie domains with `endsWith(".volcengine.com")`, not `includes`.

## Security requirements (mandatory)

This plugin moves **real session credentials** (火山方舟 console cookies: `userInfo` / `digest` JWTs, `csrfToken`). Treat them as passwords.

1. **Never commit real cookies, tokens, or keys** — anywhere, in any file, in any commit, in any branch. Use `PASTE_*` placeholders in docs/examples.
2. **Never log full cookie values** — in the plugin, the tools, or debug output.
3. **Never echo cookies in HTTP responses** — the proxy response must stay shaped to quota numbers.
4. **`.gitignore` is the last line of defense**: `settings.yaml`, `cordis.patch.yml`, `.dsh/`, `.env`, `.npmrc` are ignored. If a new file can hold credentials, ignore it too.
5. **The CDP refresh tool** runs a browser that holds your live session: loopback-only, short-lived, cleaned up on every path. Do not extend it into a long-running service.
6. Before pushing, run the secret scan (adjust patterns as needed):

   ```sh
   grep -rInE 'eyJhbGciOi|ark-[A-Za-z0-9]{20,}|gho_|ghp_|github_pat_|AKLT|Bearer [A-Za-z0-9._-]{20,}' .
   ```

   Output must contain **no real values** (only code references like `csrfToken` field names and `PASTE_*` placeholders are acceptable).

A **pro-model security review is part of the release gate**: before tagging a release, have a strong model audit the diff for secret leakage, SSRF/header injection in the proxy, XSS in the widget, and lifecycle flaws in the refresh tool.

## Testing

There is no test framework — verification is scripted and runnable with plain Node:

1. **Syntax**: `node --check lib/index.js lib/client.js tools/refresh.mjs`.
2. **Host smoke test** (mock `ctx`, no server): namespace registration with the patch config as base; `scope.get()` drives the effective config; a settings change (watch callback) makes the next request carry the new cookies; broken cookies map to `401` + `ok:false`; HEAD returns no body.
3. **Client render smoke test**: load the bundle in a `window.__ModuleLoader__` stub, call `apply` with mock `slots`/`settingsScope`, SSR the widget with `react-dom/server` (wide + rail).
4. **End-to-end**: restart DSH → `curl http://127.0.0.1:3080/ark-quota?force=1` returns fresh quota → widget renders in the sidebar footer → run `tools/refresh.mjs` once and confirm the widget updates without a restart.

## Commit & PR guidelines

- **Commit messages**: one logical change per commit, conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`), imperative summary line, body explaining *why* when non-obvious.
- **Docs**: user-facing changes update **both** `README.md` and `README.zh-CN.md`; contributing docs exist in both languages too.
- **Scope**: keep PRs small and focused. A PR that touches the proxy must come with its smoke-test evidence.
- **Backward compatibility**: DSH is a moving target — note the DSH version you tested against in the PR description.

## Release process

1. Bump `version` in `package.json` (semver).
2. Update the README if the feature set changed.
3. Run the full [Testing](#testing) checklist + the [Security requirements](#security-requirements-mandatory) scan + a pro-model security review of the diff.
4. Commit, then tag and release:

   ```sh
   git tag vX.Y.Z
   git push origin main --tags
   gh release create vX.Y.Z --generate-notes
   ```

## Reference documentation

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — official repo; [CONTRIBUTING.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md) explains why ecosystem plugins are the contribution channel.
- `@deepseek-ai/dsh-client-modules` — boot graph, `/plugins` serving, lazy `__ModuleLoader__` factory model.
- `@deepseek-ai/dsh-client-hmr` — `GET /plugins/events` reload chain and the `pnpm run dev:web` watcher requirement.
- `@deepseek-ai/dsh-client-ui-slots` — slot registration contract (`register({ name, children?, store?, inject?, ...kind }, Component)`).
- `@deepseek-ai/dsh-client-runtime` — `ctx.slots.inject` declaration injection, `bindSettingsScope` / settings namespaces.
- `@deepseek-ai/dsh-settings` / `dsh-settings-file` — host settings registry, `register(ns, schema, { base })` → `{ get, watch, update }`, hot-reloaded `settings.yaml`.
- [Cordis](https://github.com/cordiverse/cordis) — the plugin framework everything runs on.

## License

By contributing you agree your contributions are licensed under the [MIT](./LICENSE) license of this project.
