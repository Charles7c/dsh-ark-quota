# dsh-ark-quota

**English** · [简体中文](./README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH) web plugin that shows your **火山方舟 (Volcano Ark) Coding Plan subscription quota** as a fixed widget in the sidebar footer — without ever leaving the DSH GUI.

> Current version: `v0.2.0` (see [VERSION](./VERSION))

- Host half (`lib/index.js`) signs the **control-plane OpenAPI** `GetCodingPlanUsage` (falling back to `GetAFPUsage` for Agent Plan) with your Volcengine **AK/SK** (SigV4 variant) behind a same-origin route (`/ark-quota`), because the OpenAPI gateway does not allow CORS from the DSH origin. No browser, no cookies, no CSRF.
- Browser half (`lib/client.js`) renders the quota card / rail pill and auto-refreshes when the settings change; a dedicated **Settings → 方舟额度** section lets you paste the AK/SK straight into the DSH settings UI.
- `tools/check.mjs` is a zero-dependency CLI that signs one request with your AK/SK and prints your subscription quota — use it to verify keys before/after configuring.

> ⚠️ **Security note**: the quota API is authenticated with your **火山方舟 access keys (AccessKey ID + Secret)**. These are real credentials for your Volcengine account. Keep them private, never commit them, and never paste them anywhere except your own `cordis.patch.yml` / `settings.yaml` (or the DSH settings UI, which marks them `role('secret')` and never returns their values to the browser).

## Features

- Sidebar footer widget: wide card (5-hour / weekly / monthly usage bars, shown as used %) on the footer action row, or a compact pill. **The pill's color and number follow the most urgent tier** (a red 5-hour tier stays visible with the sidebar collapsed); hover it for all three tiers. Hover any row for precise percentages, absolute counts (when returned by the API), and the exact wall-clock reset time. First load shows skeleton bars so the card never jumps in height.
- **Pace signals**: for the weekly/monthly tiers the primary basis is quota progress vs time progress — the average burn since the period started (the same basis AWS Budgets / GCP Billing alerts use). It needs no snapshot history, works immediately after a reset, and cannot be thrown off by one heavy-usage day. The 5-hour tier is a **sliding window** judged by water-level dynamics instead (net rise = recent inflow − aging outflow); once capped it also reports "recovers ~HH:mm after usage stops". The rows stay clean — just label, recent rate, used % and reset countdown over one bar; status is carried by color, and hovering the rate chip shows a compact 2–3 line detail (recent vs budget rate, time/quota progress, projected run-out or recovery time). On the grey track, a **tinted forecast segment** shows where the recent rate leads (a lighter block in the same hue; its end is the farther of the recent-rate and average-pace projections). Recent burn comes from an **exponentially weighted** least-squares fit over in-window snapshots (newer points weigh more, so pace changes show up faster). Rate units match the decision horizon: **%/hour for the 5-hour tier** (budget 20%/h), **%/day for the weekly and monthly tiers** (budgets 14.3%/d and 3.3%/d, directly comparable across the two). Snapshots are persisted through `ctx.storageDomain`, so the observation history survives a restart.
- **One-click account switch**: when the 5-hour/weekly tier is projected to run out within an hour (or is already capped) and multiple accounts are configured, a red "switch to ‹account›" button appears in the card header — the target is auto-picked by the most monthly headroom.
- **Multiple accounts**: one AK/SK pair identifies one Volcengine account, so the plugin holds a list of them. A compact dropdown in the card header switches the shown account (stable for any number of accounts); the choice is persisted as the default. Display names support Chinese.
- **Route attribution & misconfiguration hints**: each account can tick the `llm` provider routes that belong to it. The settings UI lists only routes whose endpoint points at Volcano Ark (`volces.com` / `volcengine.com`) by default, and explicitly warns when a linked route is NOT a Volcano endpoint (e.g. `deepseek-official` linked by mistake); expand "show all" to untick it.
- Agent Plan fallback: when the account is not subscribed to Coding Plan, the proxy auto-detects `GetAFPUsage` and renders the absolute quota windows instead.
- Live maintenance: keys are read from the `ark-quota` settings namespace (`$DSH_HOME/settings.yaml`, hot-reloaded by `dsh-settings-file`). A change drops the cache immediately — **no server restart**.
- Settings UI: a top-level **方舟额度** section in the DSH settings manages the account list — add/remove accounts, rename them (Chinese, saved on Enter/blur), tick the routes they cover, and save AK/SK with one click (write-only fields, hot-applied, with browser autofill suppression).

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
   (`@deepseek-ai/schemastery`, `zod`) already resolve, so placing the package is enough.

3. Add an entry to your profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: ark-quota
         name: dsh-ark-quota
         config:
           accounts:
             - id: personal              # /^[a-z][a-z0-9_]*$/ internal slug; label (below) is the free-form display name
               label: 个人 Pro
               accessKeyId: ''           # optional here — fill it in the DSH Settings UI instead
               secretAccessKey: ''
               region: cn-beijing
               version: '2024-01-01'
               providers: [ark-coding-plan]
           activeAccountId: personal
           refreshMs: 300000
   ```

   The single-account shape (top-level `accessKeyId` / `secretAccessKey`, no `accounts`)
   still works and is migrated automatically into one account with id `default`.

4. Apply and verify. Editing `cordis.patch.yml` is hot-applied by DSH's HMR watcher on recent
   versions (the host route and client boot graph recompose without a restart) — check it with
   `curl -i http://127.0.0.1:3080/ark-quota`. If the route isn't live, restart the DSH server
   and refresh the browser. The widget appears at the bottom of the sidebar.

## Getting the access keys

1. Open the Volcengine console → **访问控制 (Access Control) → API 访问密钥 (API Access Keys)**.
2. Create an AccessKey (or reuse one) and note the **AccessKey ID** and **Secret Access Key**.
3. Fill them into the plugin — easiest from the DSH Settings UI: **Settings → 方舟额度**
   (saved to `$DSH_HOME/settings.yaml`, hot-applied, **no restart needed**). Or set
   `accessKeyId` / `secretAccessKey` in `cordis.patch.yml`.

> 💡 **Verify**: run `node tools/check.mjs <accessKeyId> <secretAccessKey>` (or
> `ARK_AK=… ARK_SK=… node tools/check.mjs`) to confirm the keys sign correctly against the Ark
> control-plane OpenAPI and print your subscription quota — no browser involved.

## Usage

- The widget adaptively polls `/ark-quota` at `refreshMs` (default 5 min; change it in Settings → 方舟额度 to 1/5/10/30 min or 1 hour), and immediately refreshes whenever the settings namespace changes. Only the account currently shown is polled; other accounts are loaded on demand (served from cache while fresh).
- Click the **⟳** button (or `?force=1`) for an immediate refetch of the current account.
- With two or more accounts a compact dropdown appears in the card header. Switching swaps the quota figures and pace verdict, and writes the choice back as the new default. When a short tier is about to run out, the urgent row also offers a one-click switch to the account with the most monthly headroom.
- Rows carry no verdict line: status is conveyed by the bar fill, forecast segment and rate-chip colors; hovering the rate chip shows the compact detail — for weekly/monthly, quota progress ÷ time progress (the average pace since the period started; available right after a reset, no snapshot history needed) and the projected run-out; for the 5-hour sliding-window tier, the aging rate, net rise and projected run-out/recovery time. Recent burn comes from an exponentially weighted OLS fit over in-window snapshots (30-min window for the 5-hour tier, 12 h for weekly, 24 h for monthly). Rates show as %/hour on the 5-hour tier and %/day on the weekly/monthly tiers.
- When the keys are missing or wrong you'll see an error card; fix them in Settings → 方舟额度 (or re-run `node tools/check.mjs`) and the widget updates itself.

## Configuration

All settings live in the `ark-quota` settings namespace. The composition entry config in `cordis.patch.yml` is the **base**; the user layer in `$DSH_HOME/settings.yaml` overrides it and is hot-applied.

| key                | type   | default      | description                                       |
| ------------------ | ------ | ------------ | ------------------------------------------------- |
| `accounts`         | array  | `[]`         | Volcengine accounts (see below). Empty ⇒ the legacy top-level keys are migrated into one `default` account. |
| `activeAccountId`  | string | `""`         | Which account the card shows; falls back to the first one. |
| `refreshMs`        | number | `300000`     | proxy cache TTL; one of `60000` / `300000` / `600000` / `1800000` / `3600000`. Other values snap to the nearest allowlisted cadence. |
| `accessKeyId`      | string | `""` (secret)| **Legacy** single-account AccessKey ID; read only when `accounts` is empty. |
| `secretAccessKey`  | string | `""` (secret)| **Legacy** single-account Secret Access Key.       |
| `region`           | string | `cn-beijing` | Legacy default region.                             |
| `version`          | string | `2024-01-01` | Legacy default control-plane OpenAPI version.      |

Each entry of `accounts`:

| key                | type     | default      | description                                     |
| ------------------ | -------- | ------------ | ----------------------------------------------- |
| `id`               | string   | —            | Internal slug matching `/^[a-z][a-z0-9_]*$/`; also the key under which this account's burn-rate snapshots are persisted. Invalid or duplicate ids are dropped. |
| `label`            | string   | same as `id` | Display name shown in the card and settings; free-form, supports Chinese. |
| `accessKeyId`      | string   | `""` (secret)| Volcengine AccessKey ID for this account.       |
| `secretAccessKey`  | string   | `""` (secret)| Volcengine Secret Access Key for this account.  |
| `region`           | string   | `cn-beijing` | Ark region.                                     |
| `version`          | string   | `2024-01-01` | control-plane OpenAPI version.                  |
| `providers`        | string[] | `[]`         | `llm` provider route ids that belong to this account — used to mark ownership in the settings UI and to warn when a ticked route is not a Volcano endpoint. May be empty (quota only). |

> The settings UI lists only routes whose `baseURL` points at a Volcano Ark endpoint by default, and warns about linked routes that are not (e.g. `deepseek-official`); use "show all" (`?all=1`) to untick them. The internal `id` is limited to lowercase letters/digits/underscore, while the display `label` is free-form (Chinese included).

## API

`GET /ark-quota[?account=<id>][&force=1]` → same-origin JSON:

```json
{
  "ok": true,
  "plan": "coding-plan",
  "status": "Normal",
  "updatedAt": 1786639101,
  "cachedAt": 1786639101000,
  "refreshMs": 300000,
  "hasReward": false,
  "accountId": "personal",
  "accountLabel": "个人 Pro",
  "accounts": [{ "id": "personal", "label": "个人 Pro", "configured": true, "providers": ["ark-coding-plan"] }],
  "activeAccountId": "personal",
  "quota": [
    { "level": "monthly", "percentUsed": 90.18, "percentRemaining": 9.82, "cap": 100, "rewardTotalPercent": 0, "resetAt": 1786639101, "used": 90, "total": 100 }
  ]
}
```

`cachedAt` is milliseconds since epoch (the moment this payload entered the host cache). `updatedAt` / `resetAt` stay unix seconds as returned by the console API. Each account is cached separately.

On failure: `{ "ok": false, "code": "unauthorized" | "missing-auth" | "unknown-account" | "upstream" | "network", "message": "…", "accounts": [...] }` (HTTP 401 / 404 / 502 / 504). The account list rides along on failures too, so the switcher survives a bad key.

`GET /ark-quota/providers` → `{ ok, providers: [{ id, name }], claimed: { <providerId>: <accountId> }, foreignClaimed: [{ id, name, owner }], filtered, totalProviders }` — the routes registered with the `llm` service, plus which account already claims each. Only routes pointing at a Volcano Ark endpoint are returned by default; `foreignClaimed` lists linked routes that are NOT Volcano endpoints (misconfiguration hint); `?all=1` lists everything. Never carries credentials.

`POST /ark-quota/accounts` → `{ action: "add" | "remove" | "update" | "activate", id, label?, providers? }`. Returns the same payload as `/ark-quota/status`. Credentials go through `/ark-quota/credentials` (which accepts an optional `account` field) and are never echoed back.

> The `burn` field on a quota payload (per account, per tier) carries the pace signals. **Weekly/monthly — average pace (primary):** `paceRatio` (quota progress ÷ time progress — the average burn multiplier since the period started), `projectedAtReset` (projected used % at reset at the average pace, may exceed 100), `timeProgress` / `quotaProgress`. **Recent burn:** `perDay` (exponentially weighted OLS slope over in-window snapshots, in %/day; half-life = one third of the observation window), `budgetPerDay` (the even pace that would exactly hit 100% at reset), `ratio` (recent burn ÷ budget), `trendRatio` (recent ratio ÷ average ratio; >1 means speeding up), `exhaustAt` (projected run-out time, ms — linear at the recent rate for weekly/monthly, at the net rise for the 5-hour tier), `sampleMs` / `samples` (observation span and sample count). **5-hour sliding-window tier only:** `agingPerDay` (outflow rate of usage ageing out of the window, from pre-window snapshots; the client falls back to the budget rate when absent), `netPerDay` (net rise = recent inflow − aging), `recoverAt` (when capped, projected time for the level to fall back to 95% after usage stops, ms); this tier has no time-progress projection. `status` (`ok` / `warn` / `over`) follows the average-pace projection for weekly/monthly (≥100% hits the wall, ≥85% tight); the 5-hour tier follows the recent ratio, floored at `warn` when the net rise still hits the wall and raised to `over` when that happens within an hour; when the upstream gives no reset time or the period just started, it falls back to the recent-ratio basis. Account list entries also carry `monthlyPct` (the account's latest observed monthly used %, for the switch suggestion).

## Security notes

- The `/ark-quota`, `/ark-quota/status`, `/ark-quota/providers`, `/ark-quota/accounts`, `/ark-quota/credentials`, and `/ark-quota/settings` routes are **localhost-only** (bound to the DSH server) and are **unauthenticated**: any process on the same machine can read your quota figures, force an authenticated refresh, overwrite your access keys via `POST /ark-quota/credentials`, add/remove accounts via `POST /ark-quota/accounts`, or change the `refreshMs` polling cadence via `POST /ark-quota/settings` (the same exposure as directly editing `settings.yaml` on that machine). The three state-changing POST routes additionally enforce a **same-origin check**: cross-site form POSTs from other web pages you happen to visit while DSH is running are rejected (403) based on the `Sec-Fetch-Site` / `Origin` headers, while same-machine clients like curl are unaffected. They **never echo your access keys** (responses carry only booleans / quota numbers / account ids and labels); `/ark-quota/credentials` accepts only a fixed-shape `account` / `accessKeyId` / `secretAccessKey` triple of strings, `/ark-quota/accounts` only a fixed action plus an id, label, and provider-id list, and `/ark-quota/settings` only `refreshMs` from a fixed allowlist — no user-controlled URL, so they cannot be used as a proxy/SSRF vector or leak the Volcengine credentials. Don't expose the DSH server beyond loopback while this plugin is loaded.
- Access keys are real credentials. They are stored in `cordis.patch.yml` / `settings.yaml` under `$DSH_HOME`, declared with `role('secret')` in the settings schema (the DSH settings UI shows them as write-only fields and never sends their values back to the browser), and are **excluded from git** (see `.gitignore`).
- `tools/check.mjs` only signs one request with the keys you pass on the command line / via `ARK_AK`/`ARK_SK`; it never writes them to disk and never prints them in full.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get involved, commit/PR guidelines, and the release process (简体中文见 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)). AI agents and deep-dive developers: read [AGENTS.md](./AGENTS.md) first — it covers the plugin load mechanics, coding conventions, mandatory security invariants, and the testing checklist.

## License

[MIT](./LICENSE)
