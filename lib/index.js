// dsh-ark-quota host half.
// Proxies the Volcano Ark console subscription-quota API (GetCodingPlanUsage)
// for the browser widget. The console API is not CORS-open to the DSH origin,
// so the browser half fetches this same-origin route instead.
//
// Auth: console cookies. The minimal working set is userInfo + digest
// (401 without digest) plus a csrfToken, sent both as the `csrfToken` cookie
// and as the `x-csrf-token` header. CSRF tokens rotate: when the console
// answers InvalidCSRFToken, the response `X-Need-Token` header carries the
// token it expects; we adopt it in memory and retry once. A configured token
// that went stale across a server restart is recovered automatically by the
// same bootstrap path (first call fails, we read the expected token, retry).
//
// Live maintenance: the plugin registers an `ark-quota` settings namespace
// (dsh-settings-file backs it at $DSH_HOME/settings.yaml, hot-reloaded). The
// patch entry config is the composition `base`; the user layer can override
// cookies from the GUI or by editing settings.yaml — the scope watcher drops
// the in-memory token and cache immediately, so a cookie refresh needs no
// server restart. `tools/refresh.mjs` automates the login → cookie → settings
// round trip in a popped browser window.
import z from "@deepseek-ai/schemastery";

export const name = "ark-quota";
export const inject = ["webServer", "settings"];

/** Settings namespace the user layer may override (cookies etc.). */
export const ARK_QUOTA_NS = "ark-quota";

const DEFAULT_XWEBID = "U2FsdGVkX1/5PNdS+cQxIt+7URSEcJ59ZjjT3gwhknNgNz6mZhgxNfJq59t4lEaP";
// Note: x-web-id above is the app-level header the console web app sends in its
// public JS bundle — a shared constant, NOT account-specific. Only the
// userInfo / digest / csrfToken cookies are per-account secrets.
const DEFAULT_REGION = "cn-beijing";
const DEFAULT_VERSION = "2024-01-01";
const DEFAULT_REFRESH_MS = 300000;
const UPSTREAM_TIMEOUT_MS = 20000;

export const Config = z.object({
  // console.volcengine.com cookies (paste from the browser devtools).
  userInfo: z.string(),
  digest: z.string(),
  // Optional; when stale or absent the proxy bootstraps from X-Need-Token.
  csrfToken: z.string().default(""),
  // Constant x-web-id header observed on console requests.
  xWebId: z.string().default(DEFAULT_XWEBID),
  region: z.string().default(DEFAULT_REGION),
  version: z.string().default(DEFAULT_VERSION),
  // How long the proxy serves a cached console response before refetching.
  refreshMs: z.number().min(1000).default(DEFAULT_REFRESH_MS)
});

/** Settings-layer schema (resolves base + user layer). */
export const SettingsSchema = z.object({
  userInfo: z.string(),
  digest: z.string(),
  csrfToken: z.string().default(""),
  xWebId: z.string().default(DEFAULT_XWEBID),
  region: z.string().default(DEFAULT_REGION),
  version: z.string().default(DEFAULT_VERSION),
  refreshMs: z.number().min(1000).default(DEFAULT_REFRESH_MS)
});

// Path segments are interpolated into the console URL; keep them to a strict
// allowlist so a mis-typed region/version can never reach another path on the
// console host (the host itself is hardcoded, so there is no SSRF surface).
const SEGMENT = /^[A-Za-z0-9-]+$/;
function assertSegment(part) {
  if (typeof part !== "string" || !SEGMENT.test(part)) {
    throw upstreamError("upstream", `ark-quota: invalid region/version segment: ${JSON.stringify(part)}`);
  }
}

function endpointOf(cfg) {
  assertSegment(cfg.region);
  assertSegment(cfg.version);
  return `https://console.volcengine.com/api/top/ark/${cfg.region}/${cfg.version}/GetCodingPlanUsage`;
}

function refererOf(cfg) {
  return `https://console.volcengine.com/ark/region:${cfg.region}/subscription/coding-plan`;
}

function cookieHeaderOf(cfg, token) {
  const parts = [`userInfo=${cfg.userInfo}`, `digest=${cfg.digest}`];
  if (token) parts.push(`csrfToken=${token}`);
  return parts.join("; ");
}

/** Map the console Result into the widget-friendly payload. */
function shapeResult(result) {
  const quota = (result?.QuotaUsage ?? []).map((q) => ({
    level: q.Level,
    percentUsed: typeof q.Percent === "number" ? q.Percent : 0,
    percentRemaining: Math.max(0, Math.min(100, (q.Cap ?? 100) - (typeof q.Percent === "number" ? q.Percent : 0))),
    cap: q.Cap ?? 100,
    rewardTotalPercent: q.RewardTotalPercent ?? 0,
    resetAt: typeof q.ResetTimestamp === "number" ? q.ResetTimestamp : null
  }));
  return {
    ok: true,
    status: result?.Status ?? null,
    updatedAt: typeof result?.UpdateTimestamp === "number" ? result.UpdateTimestamp : null,
    hasReward: result?.HasReward === true,
    quota
  };
}

function upstreamError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...extra });
}

export function apply(ctx, config) {
  const base = {
    userInfo: config.userInfo,
    digest: config.digest,
    csrfToken: config.csrfToken || "",
    xWebId: config.xWebId || DEFAULT_XWEBID,
    region: config.region || DEFAULT_REGION,
    version: config.version || DEFAULT_VERSION,
    refreshMs: config.refreshMs ?? DEFAULT_REFRESH_MS
  };

  let settingsScope = null;
  let token = base.csrfToken;
  let cache = null; // { at, payload }

  // Register the settings namespace; the user layer (settings.yaml / GUI)
  // overrides the patch `base`. Watchers drop token + cache so a cookie
  // refresh applies on the next request without a restart.
  ctx.effect(() => {
    const scope = ctx.settings.register(ARK_QUOTA_NS, SettingsSchema, { base });
    settingsScope = scope;
    const unwatch = scope.watch(() => {
      const next = scope.get();
      token = next.csrfToken || "";
      cache = null;
      ctx.logger.info("ark-quota: settings changed — cache and csrf token reset");
    });
    return () => {
      unwatch();
      settingsScope = null;
    };
  }, "ark-quota: settings namespace");

  /** The effective config: settings scope when mounted, else the patch base. */
  const effective = () => (settingsScope !== null ? settingsScope.get() : base);

  const cacheFresh = () => cache !== null && Date.now() - cache.at < effective().refreshMs;

  const fetchOnce = async (cfg, useToken) => {
    let resp;
    try {
      resp = await fetch(endpointOf(cfg), {
        method: "POST",
        headers: {
          "accept": "application/json, text/plain, */*",
          "content-type": "application/json",
          "x-csrf-token": useToken,
          "x-web-id": cfg.xWebId,
          "cookie": cookieHeaderOf(cfg, useToken),
          "Referer": refererOf(cfg)
        },
        body: "{}",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
    } catch (error) {
      throw upstreamError("network", `ark-quota: console request failed: ${String(error?.message ?? error)}`);
    }
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw upstreamError("upstream", `ark-quota: console returned HTTP ${resp.status} with a non-JSON body`);
    }
    const meta = json?.ResponseMetadata ?? {};
    const err = meta.Error;
    if (err?.Code === "InvalidCSRFToken") {
      const need = resp.headers.get("x-need-token");
      return { rotate: true, token: need ?? "", body: json };
    }
    if (err) {
      if (resp.status === 401) {
        throw upstreamError("unauthorized", `ark-quota: 火山方舟登录态已失效（${err.Code}: ${err.Message}）。请重新登录后更新 cookie。`);
      }
      throw upstreamError("upstream", `ark-quota: console error ${err.Code}: ${err.Message}`);
    }
    return { rotate: false, token: "", body: json };
  };

  const refresh = async () => {
    const cfg = effective();
    let attempted = false;
    let out;
    for (;;) {
      out = await fetchOnce(cfg, token);
      if (out.rotate && !attempted && out.token) {
        token = out.token;
        attempted = true;
        ctx.logger.info("ark-quota: csrf token rotated");
        continue;
      }
      break;
    }
    const payload = shapeResult(out.body?.Result);
    cache = { at: Date.now(), payload };
    return payload;
  };

  const handler = async (req, res) => {
    const isHead = req.method === "HEAD";
    const send = (status, obj) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(isHead ? "" : JSON.stringify(obj));
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(405, { ok: false, code: "method", message: "GET only" });
      return;
    }
    try {
      const force = new URL(req.url ?? "/", "http://x").searchParams.get("force") === "1";
      const payload = !force && cacheFresh() ? cache.payload : await refresh();
      send(200, payload);
    } catch (error) {
      ctx.logger.warn(error);
      // Map proxy failures to honest HTTP statuses (the client reads the JSON
      // body regardless): 401 stale session, 504 console unreachable, else 502.
      const status = error?.code === "unauthorized" ? 401
        : error?.code === "network" ? 504
        : 502;
      send(status, {
        ok: false,
        code: error?.code ?? "upstream",
        message: String(error?.message ?? error)
      });
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota",
    handler
  }), "ark-quota: /ark-quota route");
}
