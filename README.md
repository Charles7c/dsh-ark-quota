# dsh-ark-quota

**English** · [简体中文](./README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH) web plugin that shows your **火山方舟 (Volcano Ark) Coding Plan subscription quota** as a fixed widget in the sidebar footer — without ever leaving the DSH GUI.

- Host half (`lib/index.js`) proxies the console API `GetCodingPlanUsage` behind a same-origin route (`/ark-quota`), because the console API does not allow CORS from the DSH origin.
- Browser half (`lib/client.js`) renders the quota card / rail pill and auto-refreshes when the cookies change.
- `tools/refresh.mjs` pops a real browser, lets you log in once, and extracts the session cookies into `$DSH_HOME/settings.yaml` — hot-applied, **no restart needed**.

> ⚠️ **Security note**: the quota API is authenticated with your **火山方舟 console cookies** (JWT session cookies). These are highly sensitive credentials for your Volcano account. Keep them private, never commit them, and never paste them anywhere except your own `cordis.patch.yml` / `settings.yaml`.

## Features

- Sidebar footer widget: wide card (session / weekly / monthly usage bars) on the footer action row, or a compact remaining-percent pill.
- CSRF token auto-rotation: when the console answers `InvalidCSRFToken`, the proxy adopts the token from the `X-Need-Token` response header and retries once.
- Live maintenance: cookies are read from the `ark-quota` settings namespace (`$DSH_HOME/settings.yaml`, hot-reloaded by `dsh-settings-file`). A change drops the cache immediately — **no server restart**.
- One-click cookie refresh: `tools/refresh.mjs` opens your installed Edge/Chrome (macOS & Windows), you log in, it extracts and writes the cookies for you.

## Requirements

- DeepSeek Harness web runtime (`dsh web`), with `dsh-settings-file` composed (it is in the default web profile).
- A 火山方舟 Coding Plan subscription and a logged-in `console.volcengine.com` session.

## Installation

1. Make the package resolvable from your profile. The loader resolves `name: dsh-ark-quota`
   from the profile directory, so the package must physically live at
   `$DSH_HOME/profiles/<profile>/node_modules/dsh-ark-quota` (Node's normal `node_modules` walk).
   Get it there either by cloning straight into the module path:

   ```sh
   git clone https://github.com/lordqyxz/dsh-ark-quota \
     "$DSH_HOME/profiles/<profile>/node_modules/dsh-ark-quota"
   ```

   or by installing it as a dependency of the profile, e.g.
   `dsh plugin --profile <profile> add github:lordqyxz/dsh-ark-quota` (forwards to `pnpm add`).

2. Add the package to your profile's workspace (`pnpm-workspace.yaml` under `$DSH_HOME/profiles/<profile>/`)
   so pnpm treats the installed copy as a workspace member and links its dependencies:

   ```yaml
   packages:
     - .
     - 'node_modules/dsh-ark-quota'
   ```

   Then run `pnpm install` in the profile directory. If your harness already provides the
   profile's dependencies (e.g. the `$DSH_HOME/profiles/node_modules` module fallback of an
   `npx`-installed harness), `pnpm install` is optional — the package's deps
   (`@deepseek-ai/schemastery`, `yaml`) already resolve, so placing the package is enough.

3. Add an entry to your profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: ark-quota
         name: dsh-ark-quota
         config:
           userInfo: 'PASTE_USERINFO_COOKIE'
           digest: 'PASTE_DIGEST_COOKIE'
           csrfToken: ''        # optional; auto-bootstrapped when stale
           region: cn-beijing
           version: '2024-01-01'
           refreshMs: 300000
   ```

4. Apply and verify. Editing `cordis.patch.yml` is hot-applied by DSH's HMR watcher on recent
   versions (the host route and client boot graph recompose without a restart) — check it with
   `curl -i http://127.0.0.1:3080/ark-quota`. If the route isn't live, restart the DSH server
   and refresh the browser. The widget appears at the bottom of the sidebar.

## Getting the cookies

Open `https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan` in a browser **while logged in**, open DevTools → Application → Cookies → `console.volcengine.com`, and copy the values of:

- `userInfo`
- `digest`
- `csrfToken` (optional)

Only `userInfo` + `digest` are strictly required; the proxy recovers a stale or missing `csrfToken` automatically on first request.

> 💡 **Easier**: run `node tools/refresh.mjs` — it pops your installed Edge/Chrome (macOS & Windows) at the subscription page, you log in, and it extracts and writes all cookies into `$DSH_HOME/settings.yaml` automatically (no copy/paste, no restart).

## Usage

- The widget polls `/ark-quota` every `refreshMs` (default 5 min) and every time the settings namespace changes.
- Click the **⟳** button (or `?force=1`) for an immediate refetch.
- When the session expires you'll see an error card; run `node tools/refresh.mjs`, log in again, and the widget updates itself.

## Configuration

All settings live in the `ark-quota` settings namespace. The composition entry config in `cordis.patch.yml` is the **base**; the user layer in `$DSH_HOME/settings.yaml` overrides it and is hot-applied.

| key        | type   | default      | description                                |
| ---------- | ------ | ------------ | ------------------------------------------ |
| `userInfo` | string | *(required)* | console `userInfo` cookie (JWT)            |
| `digest`   | string | *(required)* | console `digest` cookie (JWT)              |
| `csrfToken`| string | `""`         | console `csrfToken` cookie (auto-rotated)  |
| `xWebId`   | string | *(built-in)* | constant `x-web-id` header                 |
| `region`   | string | `cn-beijing` | Ark region                                 |
| `version`  | string | `2024-01-01` | console API version                        |
| `refreshMs`| number | `300000`     | proxy cache TTL before refetching          |

## API

`GET /ark-quota` → same-origin JSON:

```json
{
  "ok": true,
  "status": "Normal",
  "updatedAt": 1786639101,
  "hasReward": false,
  "quota": [
    { "level": "monthly", "percentUsed": 90.18, "percentRemaining": 9.82, "cap": 100, "rewardTotalPercent": 0, "resetAt": 1786639101 }
  ]
}
```

On failure: `{ "ok": false, "code": "unauthorized" | "upstream" | "network", "message": "…" }` (HTTP 401 / 502 / 504 respectively).

## Security notes

- The `/ark-quota` route is **localhost-only** (bound to the DSH server) and is **unauthenticated**: any process on the same machine can read your quota figures or force an authenticated refresh. It **never echoes your cookies** (the response is shaped to quota numbers only) and accepts no user-controlled URL, so it cannot be used as a proxy/SSRF vector or leak the Volcano credentials. Don't expose the DSH server beyond loopback while this plugin is loaded.
- Cookies are JWT session credentials. They are stored in `cordis.patch.yml` / `settings.yaml` under `$DSH_HOME` and are **excluded from git** (see `.gitignore`).
- `tools/refresh.mjs` binds the CDP debugging port to **127.0.0.1 only** and uses a throwaway browser profile under the OS temp dir which is removed on every exit path (success, error, Ctrl+C). **While the refresh tool is running** (i.e. during your login), any other local process could connect to that port and read the session cookies of the popped browser — so log in, let it finish, and close it; don't leave it running on a shared machine.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get involved, commit/PR guidelines, and the release process (简体中文见 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)). AI agents and deep-dive developers: read [AGENTS.md](./AGENTS.md) first — it covers the plugin load mechanics, coding conventions, mandatory security invariants, and the testing checklist.

## License

[MIT](./LICENSE)
