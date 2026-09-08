// dsh-ark-quota host half.
// Proxies the Volcano Ark subscription-quota OpenAPI (GetCodingPlanUsage /
// GetAFPUsage) for the browser widget. The console quota API is not CORS-open
// to the DSH origin, so the browser half fetches this same-origin route.
//
// Auth: Volcengine access keys (AccessKey ID + Secret Access Key, created in
// 控制台 → 访问控制 → API 访问密钥). Every upstream call is signed with the
// volcano SigV4 variant (lib/signature.js) against the control-plane gateway
// open.volcengineapi.com. No browser, no cookies, no CSRF rotation, no CDP.
//
// Live maintenance: the plugin registers an `ark-quota` settings namespace
// (dsh-settings-file backs it at $DSH_HOME/settings.yaml, hot-reloaded). The
// patch entry config is the composition `base`; the user layer can override
// the access keys from the GUI or by editing settings.yaml — the scope watcher
// drops the cache immediately, so an AK/SK change needs no server restart.
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { buildSignedRequest, DEFAULT_REGION, DEFAULT_VERSION } from "./signature.js";

export const name = "ark-quota";
export const inject = ["webServer", "settings", "llm", "storageDomain"];

/** Settings namespace the user layer may override (access keys etc.). */
export const ARK_QUOTA_NS = "ark-quota";

const DEFAULT_REFRESH_MS = 300000;
const UPSTREAM_TIMEOUT_MS = 20000;

/** Cadence choices the Settings UI and POST /ark-quota/settings accept. */
export const ALLOWED_REFRESH_MS = Object.freeze([60000, 300000, 600000, 1800000, 3600000]);

/**
 * Snap an arbitrary refreshMs (YAML typo, old config, etc.) onto the allowlist.
 * Exact matches pass through; anything else lands on the nearest allowed value
 * so a 1s YAML value cannot hammer the upstream API.
 */
export function normalizeRefreshMs(v) {
  const n = Number(v);
  if (ALLOWED_REFRESH_MS.includes(n)) return n;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REFRESH_MS;
  let best = ALLOWED_REFRESH_MS[0];
  let bestDist = Math.abs(n - best);
  for (const allowed of ALLOWED_REFRESH_MS) {
    const dist = Math.abs(n - allowed);
    if (dist < bestDist) {
      best = allowed;
      bestDist = dist;
    }
  }
  return best;
}

function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * 账号 id 的合法形状：小写字母开头，只允许小写字母、数字、下划线。
 *
 * 与 dsh-storage 的 `UNIT_NAME_RE` 同一约束，因为这个 id 会成为落盘统计态里的
 * 分桶键；顺带也保证它能安全地出现在 URL 查询串里（无需转义）。
 */
export const ACCOUNT_ID_RE = /^[a-z][a-z0-9_]*$/;
/** 迁移旧单账号配置时使用的 id / 标签。 */
export const LEGACY_ACCOUNT_ID = "default";

/**
 * 一个火山账号：一组 AK/SK + 手动关联的 llm 提供方路由。
 *
 * `providers` 必须手填（不做自动推断）：一个 AK/SK 只代表一个火山账号，而
 * baseURL 只能区分 Coding Plan / Agent Plan 这两种**套餐类型**，区分不了账号
 * 归属——同一套餐路径下完全可能挂着另一个账号的密钥。猜错的代价是把别人的
 * 调用算到你的额度上，所以这里让用户显式声明。
 */
const AccountSchema = z.object({
  id: z.string().default(""),
  label: z.string().default(""),
  accessKeyId: z.string().role("secret").default(""),
  secretAccessKey: z.string().role("secret").default(""),
  region: z.string().default(DEFAULT_REGION),
  version: z.string().default(DEFAULT_VERSION),
  // 属于该账号的 llm provider 路由 id（设置页勾选）；用于在设置界面标识归属，
  // 并在勾到非火山端点时给出误配提醒。为空则只查额度。
  providers: z.array(z.string()).default([])
});

export const Config = z.object({
  // 多账号列表。为空时回落到下面的单账号字段（见 migrateAccounts）。
  accounts: z.array(AccountSchema).default([]),
  // 面板当前显示哪个账号；为空时用列表里第一个。
  activeAccountId: z.string().default(""),
  // ── 旧的单账号字段：保留以便平滑迁移与回滚，不再是权威读端 ──
  // Volcengine access keys — sign every control-plane OpenAPI call.
  // `role('secret')` keeps them off every wire surface (redacted descriptor).
  accessKeyId: z.string().role("secret").default(""),
  secretAccessKey: z.string().role("secret").default(""),
  region: z.string().default(DEFAULT_REGION),
  version: z.string().default(DEFAULT_VERSION),
  // How long the proxy serves a cached upstream response before refetching.
  // Runtime also snaps onto ALLOWED_REFRESH_MS (see normalizeRefreshMs).
  refreshMs: z.number().min(60000).max(3600000).default(DEFAULT_REFRESH_MS)
});

/** Settings-layer schema (resolves base + user layer). */
export const SettingsSchema = z.object({
  accounts: z.array(AccountSchema).default([]),
  activeAccountId: z.string().default(""),
  accessKeyId: z.string().role("secret").default(""),
  secretAccessKey: z.string().role("secret").default(""),
  region: z.string().default(DEFAULT_REGION),
  version: z.string().default(DEFAULT_VERSION),
  refreshMs: z.number().min(60000).max(3600000).default(DEFAULT_REFRESH_MS)
});

/** 归一化一个字符串字段：非字符串 → 空串。 */
function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 把配置解析成规范化的账号列表（纯函数，便于单测）。
 *
 * 迁移规则：`accounts` 为空但顶层还有 accessKeyId 时，合成一个 `default` 账号。
 * 旧字段不删除——这样降级回旧版本插件仍能读到密钥（回滚安全）。
 *
 * 同时做三件清理：
 * 1. 丢掉 id 不合法或重复的条目（id 是落盘分桶键，不能让脏值进来）；
 * 2. 标签留空时回落到 id，保证 UI 永远有可显示的名字；
 * 3. provider 去重并剔除空串。
 * @param cfg - 已通过 schema 解析的配置对象。
 * @returns 规范化后的账号数组，顺序沿用配置顺序。
 */
export function migrateAccounts(cfg) {
  const raw = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
  const source = raw.length > 0
    ? raw
    : (str(cfg?.accessKeyId) || str(cfg?.secretAccessKey)
      ? [{
          id: LEGACY_ACCOUNT_ID,
          label: "默认账号",
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
          region: cfg.region,
          version: cfg.version,
          providers: []
        }]
      : []);
  const seen = new Set();
  const out = [];
  for (const entry of source) {
    const id = str(entry?.id);
    if (!ACCOUNT_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const providers = [];
    for (const p of Array.isArray(entry?.providers) ? entry.providers : []) {
      const name = str(p);
      if (name.length > 0 && !providers.includes(name)) providers.push(name);
    }
    out.push({
      id,
      label: str(entry?.label) || id,
      accessKeyId: str(entry?.accessKeyId),
      secretAccessKey: str(entry?.secretAccessKey),
      region: str(entry?.region) || DEFAULT_REGION,
      version: str(entry?.version) || DEFAULT_VERSION,
      providers
    });
  }
  return out;
}

/**
 * 选出面板当前应显示的账号 id。
 *
 * `activeAccountId` 指向的账号被删掉时不能让面板变空白，回落到第一个。
 * @param accounts - migrateAccounts 的输出。
 * @param activeId - 配置里记录的当前账号。
 * @returns 存在的账号 id，列表为空时返回 null。
 */
export function resolveActiveAccountId(accounts, activeId) {
  const wanted = str(activeId);
  if (wanted.length > 0 && accounts.some((a) => a.id === wanted)) return wanted;
  return accounts.length > 0 ? accounts[0].id : null;
}

/** 火山方舟的域名特征（endpoint 与控制台都在这两个根域下）。 */
const ARK_HOST_RE = /(^|\.)(volces\.com|volcengine\.com)$/i;
/**
 * 路由名的方舟特征词。仅在读不到 baseURL 时兜底，所以要保守：
 * 只认明确指向方舟/火山的词，不认 "coding"、"plan" 这类通用词。
 */
const ARK_NAME_RE = /(^|[^a-z])(ark|volc|volces|volcengine|方舟|火山)([^a-z]|$)/i;

/**
 * 从适配器配置里收集"哪些 provider 路由指向火山方舟"的 baseURL 证据。
 *
 * 两条证据来源互相兜底：
 * 1. `llm.listConfigurableProviders()`：适配器官方注册的配置目录，每条带
 *    settingsNs + settingsPath，按路径取出该路由的 profile 读 baseURL。
 *    不认识的适配器也能覆盖，不用硬编码命名空间（这是主路径）。
 * 2. 已知适配器命名空间（llm-pi-ai 等）的 `providers` map：老版本适配器
 *    可能不注册 configurable 目录，直接扫它们的设置段兜底。
 *
 * 读不到就返回空表，调用方退回名称特征匹配——**只影响设置界面默认列出
 * 哪些选项**，不影响额度查询本身。
 * @param ctx - cordis 上下文。
 * @returns `{ [providerId]: baseURL }`。
 */
function arkProviderBaseUrls(ctx) {
  const out = {};
  const put = (id, url) => {
    const rid = str(id);
    const rurl = str(url);
    if (rid.length > 0 && rurl.length > 0) out[rid] = rurl;
  };
  // 路径 1：适配器自注册的 configurable 目录（官方机制，覆盖最全）。
  try {
    const entries = typeof ctx.llm?.listConfigurableProviders === "function"
      ? ctx.llm.listConfigurableProviders()
      : [];
    for (const e of Array.isArray(entries) ? entries : []) {
      const ns = str(e?.settingsNs);
      if (ns.length === 0 || typeof ctx.settings?.get !== "function") continue;
      let section;
      try {
        section = ctx.settings.get(ns);
      } catch {
        continue;
      }
      let profile = section;
      const segPath = Array.isArray(e?.settingsPath) ? e.settingsPath : [];
      for (const key of segPath) {
        if (profile === null || typeof profile !== "object") { profile = null; break; }
        profile = profile[key];
      }
      if (profile !== null && typeof profile === "object") {
        put(e.provider, profile.baseURL || profile.baseUrl || profile.endpoint);
      }
    }
  } catch { /* 目录不可用时退回命名空间扫描 + 名称匹配 */ }
  // 路径 2：已知适配器命名空间的 providers map 兜底。
  if (typeof ctx.settings?.get === "function") {
    for (const ns of ["llm-pi-ai", "llm-deepseek", "llm-openai"]) {
      let section;
      try {
        section = ctx.settings.get(ns);
      } catch {
        continue;
      }
      const providers = section?.providers;
      if (providers === null || typeof providers !== "object") continue;
      for (const [id, cfg] of Object.entries(providers)) {
        put(id, cfg?.baseURL || cfg?.baseUrl || cfg?.endpoint);
      }
    }
  }
  return out;
}

/**
 * 这个 provider 路由是不是火山方舟的。
 * @param provider - `{ id, name }`。
 * @param baseUrls - arkProviderBaseUrls 的输出。
 */
export function isArkProvider(provider, baseUrls) {
  const id = str(provider?.id);
  const url = str(baseUrls?.[id]);
  if (url.length > 0) {
    // 有 baseURL 就以它为准：域名是硬证据，名字可以随便起。
    try {
      return ARK_HOST_RE.test(new URL(url).hostname);
    } catch {
      return false;
    }
  }
  // 没有 baseURL（适配器没走 settings，或命名空间未知）→ 退回名称特征。
  return ARK_NAME_RE.test(id) || ARK_NAME_RE.test(str(provider?.name));
}

// OpenAPI actions probed in order: Coding Plan first (the plugin's home),
// falling back to Agent Plan when the account is not subscribed to coding.
const ACTIONS = {
  codingPlan: "GetCodingPlanUsage",
  agentPlan: "GetAFPUsage"
};

// Path segments interpolate into the signature only; keep them to a strict
// allowlist so a mis-typed region/version can never alter the (hardcoded)
// gateway host or request path.
const SEGMENT = /^[A-Za-z0-9-]+$/;
function assertSegment(part) {
  if (typeof part !== "string" || !SEGMENT.test(part)) {
    throw upstreamError("upstream", `ark-quota: invalid region/version segment: ${JSON.stringify(part)}`);
  }
}

function upstreamError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** Coerce a value to a finite number, or null when absent/non-numeric. */
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize an upstream epoch timestamp to SECONDS.
 *
 * The console is not self-consistent: GetCodingPlanUsage returns seconds while
 * GetAFPUsage returns milliseconds. `resetAt` is part of this plugin's payload
 * contract, so the unit is pinned here (at the parse boundary) rather than
 * sniffed in each client-side formatter.
 *
 * Threshold 1e11 is unambiguous for any real quota timestamp: read as seconds
 * it is year 5138, read as milliseconds it is 1973 — no reset time can fall on
 * the wrong side. (Feeding ms into a seconds-based formatter is what produced
 * the "20678903 天后重置" display.)
 */
function toEpochSeconds(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
}

/** Gate on auth-shaped error codes (hard-stop; credentials are wrong). */
function isAuthError(code) {
  const c = String(code ?? "").toLowerCase();
  return /auth|signature|accessdenied|denied|unauthorized|forbidden|credential|token/.test(c);
}

/** JSON helper for the plugin's own routes (never echoes credentials). */
function sendJson(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(obj));
}

/**
 * 跨站请求防护（CSRF / DNS rebinding）。
 *
 * 本插件的 POST 路由会写凭据、改账号配置，而宿主 webserver 没有内置 CSRF
 * 中间件：任意网页都能在用户开着 DSH 时，用 `<form action="127.0.0.1:3080"
 * method="post" enctype="text/plain">` 之类的跨域表单 POST 打到本地端口
 * （简单表单不触发 CORS 预检），DNS rebinding 还能读到响应。密钥不会因此
 * 泄漏（响应从不回显），但攻击者可以换掉账号里的 AK/SK、改刷新频率。
 *
 * 两层判定：
 * 1. 现代浏览器都会带 `Sec-Fetch-Site`：只放行 `same-origin`（DSH 自己的
 *    页面）与 `none`（地址栏直开等，fetch POST 不会出现这个值）；
 *    `same-site` / `cross-site` 一律拒绝。
 * 2. 旧浏览器 / curl 等不带该头时：有 `Origin` 就要求其主机与 `Host` 头
 *    一致（跨域表单伪造不了 Origin）；没有 `Origin`（非浏览器客户端）放行。
 * @param req - Node IncomingMessage（或测试桩），headers 为小写键。
 */
export function isSameOriginRequest(req) {
  const headers = req?.headers ?? {};
  const site = headers["sec-fetch-site"];
  if (typeof site === "string" && site.length > 0) {
    return site === "same-origin" || site === "none";
  }
  const origin = headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    // Host 头缺失（非标准客户端）时不拦——没有 Origin 的请求本来就放行。
    const host = headers.host;
    if (typeof host !== "string" || host.length === 0) return true;
    return originHost === host;
  }
  return true;
}

/** POST 路由统一入口守卫：非同源直接 403。 */
function rejectCrossOrigin(req, res) {
  if (isSameOriginRequest(req)) return false;
  sendJson(res, 403, {
    ok: false,
    code: "cross-origin",
    message: "拒绝跨站请求：该接口只接受来自 DSH 页面本身的调用"
  });
  return true;
}

/** Read and parse a JSON request body; `{ _parseError: true }` on malformed input. */
function readBody(req) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolvePromise(text ? JSON.parse(text) : {});
      } catch {
        resolvePromise({ _parseError: true });
      }
    });
  });
}

/** Parse GetCodingPlanUsage Result.QuotaUsage → [{ level, percentUsed, resetAt }]. */
function parseCodingPlan(result) {
  const arr = result?.QuotaUsage ?? result?.Usages ?? result?.Details ?? [];
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const level = String(item.Level ?? item.Type ?? item.Period ?? "").toLowerCase();
    if (!level) continue;
    const raw = item.Percent ?? item.UsedPercent ?? item.UsagePercent ?? 0;
    const percent = clampPercent(typeof raw === "number" ? raw : Number(raw) || 0);
    const resetAt = toEpochSeconds(item.ResetTime) ?? toEpochSeconds(item.ResetTimestamp);
    // Absolute counts (when the console returns them). Units are opaque; we
    // just surface the numbers so the widget can show "used / total" on hover.
    const used = numOrNull(item.Used ?? item.UsedCount ?? item.Consumed);
    const total = numOrNull(item.Total ?? item.Quota ?? item.Limit ?? item.TotalCount);
    out.push({ level, percentUsed: percent, resetAt, used, total });
  }
  return out;
}

/** Parse GetAFPUsage Result windows → [{ level, percentUsed, resetAt }]. */
function parseAgentPlan(result) {
  const windows = [
    ["AFPFiveHour", "session"],
    ["AFPWeekly", "weekly"],
    ["AFPMonthly", "monthly"]
  ];
  const out = [];
  for (const [key, level] of windows) {
    const win = result?.[key];
    const quota = Number(win?.Quota ?? 0);
    if (!(quota > 0)) continue;
    const used = Number(win?.Used ?? 0);
    out.push({
      level,
      percentUsed: clampPercent((used / quota) * 100),
      resetAt: toEpochSeconds(win.ResetTime),
      used,
      total: quota
    });
  }
  return out;
}

/** Map a resolved tier list into the widget-friendly payload. */
function shapeResult(tiers, plan, raw) {
  const quota = tiers.map((t) => ({
    level: t.level,
    percentUsed: clampPercent(t.percentUsed),
    percentRemaining: clampPercent(100 - clampPercent(t.percentUsed)),
    cap: 100,
    rewardTotalPercent: 0,
    resetAt: t.resetAt,
    used: typeof t.used === "number" && Number.isFinite(t.used) ? t.used : null,
    total: typeof t.total === "number" && Number.isFinite(t.total) ? t.total : null
  }));
  return {
    ok: true,
    plan,
    status: raw?.Status ?? null,
    updatedAt: toEpochSeconds(raw?.UpdateTimestamp) ?? Math.floor(Date.now() / 1000),
    hasReward: raw?.HasReward === true,
    quota
  };
}

/**
 * 额度快照与消耗速度（burn-rate）。
 *
 * 方舟的配额 OpenAPI 只返回当前额度百分比，要回答"按这个速度能用到什么时候"，
 * 必须在每次上游刷新时记一个快照（时间 + 各周期百分比），由快照序列算速率。
 * 快照通过 storageDomain 落盘，重启后历史不丢（消耗速度的观测窗口最长 24 小时）。
 */
/**
 * 落盘域名。
 *
 * 必须匹配 dsh-storage 的 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`：小写字母开头，
 * 只允许小写字母、数字、下划线，**不能有连字符**。早先写成 `ark-quota-stats`
 * 会让 `storageDomain.open()` 直接抛 `invalid-name`，插件静默退回内存态，
 * 重启后快照历史全丢。
 */
const STATS_DOMAIN = "ark_quota_stats";
/** 落盘节流：突发刷新合并成一次写。 */
const STATS_FLUSH_MS = 2000;

/**
 * 额度快照保留时长：14 天。
 *
 * 快照用来算「消耗速度」：只有两个时间点的百分比差才能得出速率。14 天足以
 * 覆盖最长的月度周期，又不会让落盘文件无限增长。
 */
const SNAP_RETAIN_MS = 14 * 24 * 60 * 60 * 1000;
/** 额度快照的最小采样间隔：5 分钟。比这更密没有信息量（上游本身有缓存）。 */
const SNAP_MIN_GAP_MS = 5 * 60 * 1000;
/**
 * 各周期算燃烧速率时回看多久。
 *
 * 窗口要与周期长度匹配：5 小时的 session 用 30 分钟窗口才跟得上，
 * 月度用 30 分钟窗口则会被单次会话的抖动主导。
 */
const BURN_WINDOW_MS = {
  session: 30 * 60 * 1000,
  weekly: 12 * 60 * 60 * 1000,
  monthly: 24 * 60 * 60 * 1000
};
/** 各周期的完整时长，用于算「预算速率」（匀速用完刚好到重置）。 */
const PERIOD_MS = {
  session: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000
};
/**
 * 燃烧倍率分档（对齐 AWS Budgets / GCP Billing 的告警语义）。
 * ≤1.0 表示按这个速度用到重置时刚好够；>1.5 视为明显超速。
 *
 * 阈值留 0.5% 容差：倍率是两个浮点数相除得来的，"恰好按预算速度"在数值上
 * 常常是 1.0000000000000002，不留容差会把它误判成超速。
 */
const BURN_EPS = 0.005;
const BURN_OK = 1.0 + BURN_EPS;
const BURN_WARN = 1.5 + BURN_EPS;

/**
 * 近期速率做最小二乘回归所需的最小观测跨度。
 *
 * 跨度太短时两三个点的抖动就会决定斜率：月档要求 6 小时、周档 3 小时、
 * 5 小时档 10 分钟。这只影响「近期速率」这个配角信号——主角（节奏投影）
 * 只依赖时间进度与当前水位，不需要快照历史。
 */
const BURN_MIN_SPAN_MS = {
  session: 10 * 60 * 1000,
  weekly: 3 * 60 * 60 * 1000,
  monthly: 6 * 60 * 60 * 1000
};
/**
 * 周期已走过的比例不足这个值时，节奏倍率不下结论。
 *
 * 周期刚开始时「额度进度 ÷ 时间进度」极不稳定：时间过了 2%、额度用了 5%
 * 就会算出 2.5 倍的虚高倍率。10% 之前只展示近期速率，不报节奏结论。
 */
const PACE_MIN_TIME_PROGRESS = 0.1;

/**
 * 跨重置回落的识别阈值（百分点）。
 *
 * 固定周期重置是 ~90% → 个位数的跳水；5 小时滑窗的额度老化则是小幅回落
 * （相邻采样点 5 分钟，满速烧也就 ~1.7% 的落差）。只有回落幅度超过这个阈值
 * 才认定为「周期重置」并截断回归样本；小幅回落必须保留——否则回归里只剩
 * 单调上升段，近期速率会被系统性高估（把老化恢复误当成还在烧）。
 */
const RESET_DROP_PCT = 25;

/** 一次额度快照：t = 毫秒时间戳，p = 各周期的已用百分比。 */
const QuotaSnapSchema = zod.object({
  t: zod.number(),
  p: zod.record(zod.string(), zod.number())
});

/**
 * 落盘的快照全局态。表集合为空——这个域只有一个单例槽。
 *
 * **为什么保持 version 1、字段全 optional：** dsh-storage-json 对版本号是严格
 * 相等判定（`version !== descriptor.version` → 抛 `version-mismatch`），升版号
 * 会让已有文档直接读不出来。旧文档里的请求统计字段（total/ok/fail/buckets/
 * byAccount 等）读回时一律忽略，只有 snapsByAccount 参与合并。
 */
const StatsGlobalSchema = zod.object({
  startedAt: zod.number().optional(),
  snapsByAccount: zod.record(zod.string(), zod.array(QuotaSnapSchema)).optional()
});

/** 手写 domain spec：`defineDomain` 只做作者期校验，`open` 会再校验一遍。 */
function statsDomainSpec() {
  return {
    name: STATS_DOMAIN,
    version: 1,
    global: {
      schema: StatsGlobalSchema,
      initial: { snapsByAccount: {} }
    },
    tables: {}
  };
}

/**
 * 把落盘读回的态归一成 `{ snapsByAccount }`（纯函数）。
 *
 * 旧文档可能携带请求统计时代的字段（v1 扁平 total/ok/fail/buckets、v2
 * byAccount），这些功能已下线，读回时全部丢弃；额度快照是唯一仍有价值的数据。
 * @param stored - 落盘读回的对象，或 undefined。
 * @param nowMs - 当前时刻，用于裁剪超出保留窗口的快照。
 */
export function migrateStatsState(stored, nowMs) {
  const snapsByAccount = {};
  const rawSnaps = stored?.snapsByAccount;
  if (rawSnaps !== null && typeof rawSnaps === "object") {
    for (const [id, list] of Object.entries(rawSnaps)) {
      if (!ACCOUNT_ID_RE.test(id) || !Array.isArray(list)) continue;
      const kept = pruneSnaps(
        list.filter((s) => s !== null && typeof s === "object" && Number.isFinite(s.t)),
        nowMs
      );
      // 全部过期/非法的账号不留空键：merge 时空数组只会制造噪音。
      if (kept.length > 0) snapsByAccount[id] = kept;
    }
  }
  return { snapsByAccount };
}
/** 丢掉超出保留窗口的额度快照。 */
export function pruneSnaps(snaps, nowMs) {
  const oldest = nowMs - SNAP_RETAIN_MS;
  return snaps.filter((s) => s.t >= oldest);
}

/**
 * 记一次额度快照（纯函数）。
 *
 * 采样太密没有信息量（上游本身带缓存，短时间内返回同一份数据），所以距上一次
 * 不足 `SNAP_MIN_GAP_MS` 时直接返回原数组——但百分比确实变了的话仍然记，
 * 免得错过一次突发消耗。
 * @param snaps - 现有快照序列（按时间升序）。
 * @param quota - shapeResult 产出的 quota 数组。
 * @param nowMs - 当前时刻。
 */
export function foldSnap(snaps, quota, nowMs) {
  const p = {};
  for (const q of Array.isArray(quota) ? quota : []) {
    if (typeof q?.level === "string" && Number.isFinite(q.percentUsed)) p[q.level] = q.percentUsed;
  }
  if (Object.keys(p).length === 0) return snaps;
  const last = snaps.length > 0 ? snaps[snaps.length - 1] : null;
  if (last !== null && nowMs - last.t < SNAP_MIN_GAP_MS) {
    // 间隔不够，但百分比变了 → 覆盖最后一条（保留最新观测，不增加长度）。
    const changed = Object.keys(p).some((k) => p[k] !== last.p[k]);
    if (!changed) return snaps;
    const next = snaps.slice(0, -1);
    next.push({ t: nowMs, p });
    return pruneSnaps(next, nowMs);
  }
  return pruneSnaps(snaps.concat([{ t: nowMs, p }]), nowMs);
}

/**
 * 一组观测点做（加权）最小二乘，求消耗斜率（纯函数）。
 *
 * 为什么不用「基线一点 vs 当前一点」：单点基线恰好落在一次突发消耗之后，
 * 就会把整个速率带飞。OLS 让窗口内每个观测都参与回归，单点抖动被摊薄。
 *
 * 权重按点年龄指数衰减（半衰期 halflife）：越新的点权重越高，用量节奏
 * 突变（开会/下班）时反应比等权回归快 1~2 个采样间隔；halflife 传 0 时
 * 退化为等权 OLS（老化速率描述的是一整段时间的平均流出，不偏重新点）。
 * 净斜率为负（数据异常）时返回 null（不猜）。
 * @returns `{ perDay, span, samples }`；样本不足时返回 null。
 */
function olsSlope(pts, level, nowMs, halflife) {
  const n = pts.length;
  if (n < 2) return null;
  const ws = new Array(n);
  let W = 0;
  let sumWT = 0;
  let sumWP = 0;
  for (let i = 0; i < n; i++) {
    const age = Math.max(0, nowMs - pts[i].t);
    const w = halflife > 0 ? Math.exp(-age / halflife) : 1;
    ws[i] = w;
    W += w;
    sumWT += w * pts[i].t;
    sumWP += w * pts[i].p[level];
  }
  if (W <= 0) return null;
  const meanT = sumWT / W;
  const meanP = sumWP / W;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dt = pts[i].t - meanT;
    num += ws[i] * dt * (pts[i].p[level] - meanP);
    den += ws[i] * dt * dt;
  }
  if (den <= 0) return null;
  const slopePerMs = num / den;
  // 截断后仍为净下降（数据异常）→ 不报速率。
  if (slopePerMs < 0) return null;
  return { perDay: slopePerMs * 86400000, span: nowMs - pts[0].t, samples: n };
}

/**
 * 窗口内快照对当前水位做最小二乘，求近期消耗斜率（纯函数）。
 *
 * 取样：窗口内全部快照 + 窗口起点之前最近的一条（基线；年龄超过两个窗口
 * 就不要了——插件几天没开时，那种高杠杆老点会把短窗口斜率强行拉成长期
 * 均值）；当前水位作为最新观测点参与回归。
 *
 * 跨周期重置（百分比大幅回落，如 98% → 3%）不是负消耗：从最新点往回扫，
 * 回落幅度超过 RESET_DROP_PCT 才把回落点及其之前全部丢弃；滑窗老化造成的
 * 小幅回落保留（olsSlope 容得下这类噪声，截掉反而高估速率）。跨度不足时
 * 返回 null（不猜）。
 * @returns `{ perDay, span, samples }`；样本不足时返回 null。
 */
function recentSlope(snaps, level, percentUsed, nowMs, windowMs, minSpanMs) {
  const from = nowMs - windowMs;
  const pts = [];
  let before = null;
  for (const s of snaps) {
    if (!Number.isFinite(s?.p?.[level])) continue;
    if (s.t <= from) {
      before = s;
    } else if (s.t <= nowMs) {
      pts.push(s);
    }
  }
  // 窗口前的基线点：年龄不超过两个窗口才采用；窗口内又没有点时直接放弃。
  if (before !== null && nowMs - before.t <= windowMs * 2) pts.unshift(before);
  else if (pts.length === 0) return null;
  // 当前水位是最新的一条观测。
  pts.push({ t: nowMs, p: { [level]: percentUsed } });
  // 跨重置截断：只有大幅跳水才认定为重置；滑窗老化的小幅回落保留。
  for (let i = pts.length - 1; i > 0; i--) {
    if (pts[i - 1].p[level] > pts[i].p[level] + RESET_DROP_PCT) {
      pts.splice(0, i);
      break;
    }
  }
  if (pts.length < 2) return null;
  const span = nowMs - pts[0].t;
  if (span < minSpanMs) return null;
  // 指数加权回归：半衰期 = 观测窗口的 1/3，最新观测权重最高。
  return olsSlope(pts, level, nowMs, windowMs / 3);
}

/**
 * 滑窗「老化速率」：正在滑出观测窗口的那段消耗的斜率（纯函数）。
 *
 * 5 小时滑窗的水位 = 最近 5 小时消耗，水位变化率 = 近期流入速率 − 窗口前
 * 的流出（老化）速率。老化速率取 [now-2×window, now-window] 区间快照的
 * 等权斜率——那正是接下来一个窗口长度内会陆续滑出的消耗。区间内样本
 * 不足（跨度 < 窗口的 1/3）时返回 null，调用方用预算速率做先验。
 * @returns 老化速率（%/天）；算不出时返回 null。
 */
function agingSlope(snaps, level, nowMs, windowMs) {
  const lo = nowMs - windowMs * 2;
  const hi = nowMs - windowMs;
  const pts = [];
  for (const s of snaps) {
    if (!Number.isFinite(s?.p?.[level])) continue;
    if (s.t >= lo && s.t <= hi) pts.push(s);
  }
  if (pts.length < 2) return null;
  const span = pts[pts.length - 1].t - pts[0].t;
  if (span < windowMs / 3) return null;
  // 等权回归：这一段描述「过去那段时间的平均流出」，不需要偏重新点。
  const r = olsSlope(pts, level, pts[pts.length - 1].t, 0);
  return r ? r.perDay : null;
}

/**
 * 由快照序列与当前水位算出一个周期的用量节奏（burn-rate 口径）。
 *
 * 两个信号，主次分明：
 *
 * - **节奏投影（主角）**：`paceRatio = 额度进度 ÷ 时间进度`，即开周期以来
 *   的平均燃烧倍率；`projectedAtReset = paceRatio × 100` 是按这个平均节奏
 *   外推到重置时的已用百分比（可能 >100，≥100 表示撑不到重置）。它只
 *   依赖当前水位与上游给的重置时刻，不需要快照历史，重置后立刻可用，也
 *   不会被某一天的重度使用带飞——这是 AWS Budgets / GCP Billing 同类
 *   告警的实际口径（累计用量 vs 时间进度）。
 * - **近期速率（配角）**：窗口内全部快照对当前水位做指数加权最小二乘斜率
 *   得到 `perDay`，表达「最近烧得多快」；`ratio` 是它相对预算速率的倍率，
 *   `trendRatio` 是近期倍率 ÷ 平均倍率（>1 说明最近在加速）。周/月档超速时
 *   `exhaustAt` 给出按近期速度的预计用完时刻；月度档不展示点时刻——
 *   24 小时窗口外推 30 天没有可信度。
 * - **5 小时档是滑动窗口（AFPFiveHour）**：水位 = 最近 5 小时消耗，没有
 *   「周期累计 / 时间进度」概念，时间进度投影不适用，改用水位动力学：
 *   净增速 = 近期流入速率 − 窗口老化速率（`agingPerDay`，取窗口前一段
 *   快照斜率，缺失时用预算速率做先验）。净增速 ≤ 0 时水位不会到顶（按
 *   近期速度会收敛在 100% 以下），`exhaustAt` 为 null；> 0 时按净增速外推
 *   用完时刻。已撞线（≥99.5%）时给 `recoverAt`：停用后水位按老化速率
 *   回落到 95% 的预计时刻。
 *
 * 状态分档：周/月档以节奏投影为准（≥100% 撞线 / ≥85% 余量紧张 / 其余正常），
 * 5 小时档以近期倍率为准、净增速仍会撞线时至少 warn、1 小时内撞线升 over；
 * 上游没给 resetAt、或周期刚起步（时间进度 <10%）时退回近期倍率口径。
 * 两个信号都算不出来时返回 null。
 *
 * 速率单位必须按窗口匹配展示（5 小时/周档用 %/小时、月档用 %/天）：
 * 2%/天 对月度周期很安全，对 5 小时周期是灾难，预算速率始终一起给出。
 * @param snaps - 快照序列。
 * @param level - session / weekly / monthly。
 * @param percentUsed - 当前已用百分比。
 * @param nowMs - 当前时刻。
 * @param resetAtSec - 上游返回的重置时刻（unix 秒），可缺省。
 * @returns 速率对象，两个信号都缺失时返回 null。
 */
export function burnRate(snaps, level, percentUsed, nowMs, resetAtSec) {
  const windowMs = Object.prototype.hasOwnProperty.call(BURN_WINDOW_MS, level)
    ? BURN_WINDOW_MS[level] : BURN_WINDOW_MS.monthly;
  const periodMs = Object.prototype.hasOwnProperty.call(PERIOD_MS, level)
    ? PERIOD_MS[level] : PERIOD_MS.monthly;
  const minSpanMs = Object.prototype.hasOwnProperty.call(BURN_MIN_SPAN_MS, level)
    ? BURN_MIN_SPAN_MS[level] : BURN_MIN_SPAN_MS.monthly;
  const isSliding = level === "session";

  // ── 近期速率（配角）：窗口内快照 + 当前水位的加权最小二乘斜率 ────
  const recent = recentSlope(snaps, level, percentUsed, nowMs, windowMs, minSpanMs);
  const perDay = recent ? recent.perDay : null;
  const budgetPerDay = (100 / periodMs) * 86400000;
  const ratio = perDay !== null && budgetPerDay > 0 ? perDay / budgetPerDay : null;
  const remaining = Math.max(0, 100 - percentUsed);

  // ── 滑窗老化速率与耗尽/恢复时刻（仅 5 小时滑窗档）──────────────
  // 固定周期档在重置前额度不恢复，exhaustAt 直接按近期速率线性外推；
  // 滑窗档水位 = 流入 − 老化，必须按净增速算，否则会把「老化恢复」漏掉、
  // 系统性地过早报撞线。
  let agingPerDay = null;
  let netPerDay = null;
  let recoverAt = null;
  let exhaustAt = null;
  if (isSliding) {
    agingPerDay = agingSlope(snaps, level, nowMs, windowMs);
    // 老化速率缺失（插件刚装、窗口前没有快照）时用预算速率做先验：
    // 稳态假设下「过去按预算速度烧」是最中性的猜测。
    const aging = agingPerDay !== null ? agingPerDay : budgetPerDay;
    netPerDay = perDay !== null ? perDay - aging : null;
    if (netPerDay !== null && netPerDay > 0.05 && remaining > 0) {
      exhaustAt = nowMs + (remaining / netPerDay) * 86400000;
    }
    // 已到上限（限流）时，停用后水位按老化速率回落：回落到 95%（留安全
    // 余量，100%→99% 那种刚恢复的状态不稳）的预计时刻。
    if (percentUsed >= 99.5 && aging > 0) {
      const recoverPct = percentUsed - 95;
      if (recoverPct > 0) recoverAt = nowMs + (recoverPct / aging) * 86400000;
    }
  } else {
    exhaustAt = perDay !== null && perDay > 0 && remaining > 0
      ? nowMs + (remaining / perDay) * 86400000
      : null;
  }

  // ── 节奏投影（主角）：额度进度 ÷ 时间进度（仅固定周期档）─────────
  // 滑窗档没有周期累计概念，不做此投影。resetAt 是上游给的真实重置时刻；
  // 周期长度用 PERIOD_MS 近似（上游不返回周期起点）。重置时刻已过（上游
  // 尚未刷新）或远得离谱时投影无意义。
  let projectedAtReset = null;
  let timeProgress = null;
  let paceRatio = null;
  if (!isSliding
    && typeof resetAtSec === "number" && Number.isFinite(resetAtSec) && resetAtSec > 0) {
    const remainMs = resetAtSec * 1000 - nowMs;
    if (remainMs > 0 && remainMs <= periodMs + 60 * 60 * 1000) {
      timeProgress = Math.min(1, Math.max(0, 1 - remainMs / periodMs));
      // 周期刚起步时小分母会让倍率爆炸，不足 10% 不下节奏结论。
      if (timeProgress >= PACE_MIN_TIME_PROGRESS && timeProgress > 0) {
        paceRatio = (percentUsed / 100) / timeProgress;
        projectedAtReset = paceRatio * 100;
      }
    }
  }
  // 近期相对平均节奏的趋势：>1 最近在加速，<1 在放缓。
  const trendRatio = ratio !== null && paceRatio !== null && paceRatio > 0
    ? ratio / paceRatio : null;

  // 分档供前端取色：ok（节奏正常）/ warn（余量紧张）/ over（撞线）。
  // 周/月档有投影时以投影为准；没有 resetAt、周期刚起步、或 5 小时滑窗档
  // 时退回近期倍率口径。
  let status = null;
  if (projectedAtReset !== null) {
    status = projectedAtReset >= 100 - 0.5 ? "over" : projectedAtReset >= 85 ? "warn" : "ok";
  } else if (ratio !== null) {
    status = ratio <= BURN_OK ? "ok" : ratio <= BURN_WARN ? "warn" : "over";
  }
  if (isSliding && exhaustAt !== null) {
    // 净增速仍会撞线（实测老化低于预算）时至少报 warn；1 小时内撞线升 over。
    const rank = { ok: 0, warn: 1, over: 2 };
    const floor = (exhaustAt - nowMs) < 60 * 60 * 1000 ? "over" : "warn";
    if (status === null || rank[status] < rank[floor]) status = floor;
  }
  // 两个信号都缺失（无近期样本且滑窗也算不出净额）→ 调用方不渲染。
  if (projectedAtReset === null && perDay === null) return null;
  return {
    level,
    perDay,
    budgetPerDay,
    ratio,
    // 滑窗档专有：老化（流出）速率、净增速、停用后回落到 95% 的时刻。
    agingPerDay,
    netPerDay,
    recoverAt,
    // 节奏投影：平均倍率、投影百分比、时间进度、额度进度（= 当前已用比例）。
    paceRatio,
    trendRatio,
    status,
    exhaustAt,
    projectedAtReset,
    timeProgress,
    quotaProgress: percentUsed / 100,
    // 近期速率的观测跨度与样本数（供前端标注数据质量）。
    sampleMs: recent ? recent.span : null,
    samples: recent ? recent.samples : null
  };
}
/**
 * 多账号态：记一次额度快照到指定账号名下（用于算消耗速度）。
 * @param state - 多账号态。
 * @param accountId - 目标账号 id。
 * @param quota - shapeResult 产出的 quota 数组。
 * @param nowMs - 当前时刻。
 */
export function foldSnapFor(state, accountId, quota, nowMs) {
  if (accountId === null || accountId === undefined) return state;
  const snaps = state.snapsByAccount?.[accountId] ?? [];
  const next = foldSnap(snaps, quota, nowMs);
  if (next === snaps) return state;
  return {
    ...state,
    snapsByAccount: { ...(state.snapsByAccount ?? {}), [accountId]: next }
  };
}

/**
 * 多账号态：丢弃一个账号的快照桶（纯函数）。
 *
 * 账号删除后它的消耗速度历史没有任何意义；更重要的是，如果不删，同名 id
 * 重建账号时 mergeStatsState 会把旧账号的快照合并进来，新账号的 burn-rate
 * 会被前主人的用量污染。
 * @param state - 多账号态。
 * @param accountId - 被删除的账号 id。
 */
export function dropAccountSnaps(state, accountId) {
  const bucket = state?.snapsByAccount;
  if (bucket === null || typeof bucket !== "object"
    || !Object.prototype.hasOwnProperty.call(bucket, accountId)) {
    return state;
  }
  const next = { ...bucket };
  delete next[accountId];
  return { ...state, snapsByAccount: next };
}

/**
 * 多账号态：算出一个账号各周期的消耗速度。
 * @param state - 多账号态。
 * @param accountId - 目标账号 id。
 * @param quota - 当前的 quota 数组。
 * @param nowMs - 当前时刻。
 * @returns `{ [level]: burnRate }`，样本不足的周期不出现在结果里。
 */
export function burnRatesFor(state, accountId, quota, nowMs) {
  const snaps = (accountId !== null && accountId !== undefined
    ? state.snapsByAccount?.[accountId]
    : null) ?? [];
  const out = {};
  for (const q of Array.isArray(quota) ? quota : []) {
    if (typeof q?.level !== "string" || !Number.isFinite(q.percentUsed)) continue;
    const r = burnRate(snaps, q.level, q.percentUsed, nowMs, q.resetAt);
    if (r !== null) out[q.level] = r;
  }
  return out;
}

/** 落盘用的快照：只写 snapsByAccount。 */
export function snapshotStatsState(state) {
  return { snapsByAccount: state.snapsByAccount ?? {} };
}

/**
 * 合并落盘读回的快照与域打开前内存里新采的快照（纯函数）。
 *
 * 域是异步打开的，这段窗口里采到的快照先记在内存态里，打开成功后按时间合并
 * 去重，再裁掉超出保留窗口的旧快照。
 * @param stored - 已经 migrateStatsState 过的落盘态。
 * @param live - 当前内存态。
 * @param nowMs - 当前时刻。
 */
export function mergeStatsState(stored, live, nowMs) {
  const snapsByAccount = {};
  const snapIds = new Set([
    ...Object.keys(stored.snapsByAccount ?? {}),
    ...Object.keys(live.snapsByAccount ?? {})
  ]);
  for (const id of snapIds) {
    const merged = (stored.snapsByAccount?.[id] ?? []).concat(live.snapsByAccount?.[id] ?? []);
    merged.sort((a, b) => a.t - b.t);
    const kept = pruneSnaps(merged, nowMs);
    if (kept.length > 0) snapsByAccount[id] = kept;
  }
  return { snapsByAccount };
}

export function apply(ctx, config) {
  const base = {
    accounts: Array.isArray(config.accounts) ? config.accounts : [],
    activeAccountId: config.activeAccountId || "",
    accessKeyId: config.accessKeyId || "",
    secretAccessKey: config.secretAccessKey || "",
    region: config.region || DEFAULT_REGION,
    version: config.version || DEFAULT_VERSION,
    refreshMs: normalizeRefreshMs(config.refreshMs ?? DEFAULT_REFRESH_MS)
  };

  let settingsScope = null;
  // 每个账号一份缓存：不同账号打的是不同上游账号，绝不能共用一条缓存。
  const caches = new Map(); // accountId -> { at, payload }
  // 每个账号一个在途请求：缓存过期瞬间的并发请求（多窗口、保存后 fan-out
  // 刷新）只允许打一次上游，其余等同一个 Promise。
  const inflight = new Map(); // accountId -> Promise<payload>

  // Register the settings namespace; the user layer (settings.yaml / GUI)
  // overrides the patch `base`. Watchers drop the cache so an AK/SK change
  // applies on the next request without a restart.
  ctx.effect(() => {
    const scope = ctx.settings.register(ARK_QUOTA_NS, SettingsSchema, { base });
    settingsScope = scope;
    const unwatch = scope.watch(() => {
      caches.clear();
      ctx.logger.info("ark-quota: settings changed — cache reset");
    });
    return () => {
      unwatch();
      settingsScope = null;
    };
  }, "ark-quota: settings namespace");

  /**
   * The effective config: settings scope when mounted, else the patch base.
   *
   * 额外附上规范化后的账号列表与当前账号 id：整个插件（额度查询、统计归属、
   * 路由响应）都只读这两个派生字段，不再直接碰顶层的单账号密钥。
   */
  const effective = () => {
    const cfg = settingsScope !== null ? settingsScope.get() : base;
    const accounts = migrateAccounts(cfg);
    return {
      ...cfg,
      refreshMs: normalizeRefreshMs(cfg.refreshMs),
      accounts,
      activeAccountId: resolveActiveAccountId(accounts, cfg.activeAccountId)
    };
  };

  /** 取一个账号；id 缺省时取当前账号。找不到返回 null。 */
  const accountOf = (id) => {
    const cfg = effective();
    const wanted = str(id) || cfg.activeAccountId;
    if (wanted === null || wanted === "") return null;
    return cfg.accounts.find((a) => a.id === wanted) ?? null;
  };

  // ── 额度快照：落盘态 ────────────────────────────────────────────────────
  // 消耗速度（burn-rate）完全由额度快照序列算出：每次真正从上游刷新额度时
  // 记一个快照（时间 + 各周期已用百分比），两个时间点的百分比差就是速率。
  // 内存态是权威读端，落盘只是重启后的续命（观测窗口最长 24 小时）；
  // 域打开前先记在内存，打开成功后与落盘历史合并，不丢启动瞬间的样本。
  let snapState = { snapsByAccount: {} };
  let statsDomain = null;
  let statsTimer = null;
  let statsDirty = false;

  const flushStats = () => {
    statsTimer = null;
    if (statsDomain === null || !statsDirty) return;
    statsDirty = false;
    // 落盘失败不影响读端：内存态仍是权威，记一条错误日志即可。
    Promise.resolve(statsDomain.global.set(snapshotStatsState(snapState))).catch((error) => {
      ctx.logger.error(`ark-quota: 额度快照落盘失败：${String(error?.message ?? error)}`);
    });
  };

  const scheduleFlush = () => {
    statsDirty = true;
    if (statsTimer !== null || statsDomain === null) return;
    statsTimer = setTimeout(flushStats, STATS_FLUSH_MS);
    if (typeof statsTimer?.unref === "function") statsTimer.unref();
  };

  /** 记一次额度快照（消耗速度的数据来源）。 */
  const recordSnap = (accountId, quota) => {
    if (accountId === null) return;
    const next = foldSnapFor(snapState, accountId, quota, Date.now());
    if (next === snapState) return;
    snapState = next;
    scheduleFlush();
  };

  ctx.effect(() => {
    if (ctx.storageDomain === undefined || typeof ctx.storageDomain.open !== "function") {
      ctx.logger.info("ark-quota: storageDomain 不可用，额度快照仅存于内存");
      return () => {};
    }
    let opened = null;
    Promise.resolve(ctx.storageDomain.open(statsDomainSpec()))
      .then((domain) => {
        opened = domain;
        statsDomain = domain;
        const nowMs = Date.now();
        // 旧文档里的请求统计字段（total/ok/fail/buckets/byAccount）在
        // migrate 时一律丢弃，只合并额度快照。
        const stored = migrateStatsState(domain.global.get(), nowMs);
        snapState = mergeStatsState(stored, snapState, nowMs);
        const snapCount = Object.values(snapState.snapsByAccount)
          .reduce((n, list) => n + list.length, 0);
        ctx.logger.info(`ark-quota: 快照域已打开（${snapCount} 条历史快照）`);
        if (statsDirty) scheduleFlush();
      })
      .catch((error) => {
        // 域名不合法这类硬错误不能静默吞掉，要留可见日志。
        ctx.logger.error(
          `ark-quota: 快照域打开失败，退回内存态（重启后消耗速度历史会丢）：${String(error?.message ?? error)}`
        );
      });
    return () => {
      if (statsTimer !== null) {
        clearTimeout(statsTimer);
        statsTimer = null;
      }
      const domain = opened;
      statsDomain = null;
      if (domain === null) return;
      // 卸载前把最后一次增量写下去，再关域。
      Promise.resolve(domain.global.set(snapshotStatsState(snapState)))
        .catch(() => {})
        .then(() => domain.close())
        .catch(() => {});
    };
  }, "ark-quota: 额度快照域");

  /** 该账号的缓存是否还新鲜。 */
  const cacheFresh = (accountId) => {
    const entry = caches.get(accountId);
    return entry !== undefined && Date.now() - entry.at < effective().refreshMs;
  };

  const fetchOnce = async (cfg, action) => {
    assertSegment(cfg.region);
    assertSegment(cfg.version);
    const { url, headers } = buildSignedRequest({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      version: cfg.version,
      action
    });
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: "",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
    } catch (error) {
      throw upstreamError("network", `ark-quota: OpenAPI request failed: ${String(error?.message ?? error)}`);
    }
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw upstreamError("upstream", `ark-quota: OpenAPI returned HTTP ${resp.status} with a non-JSON body`);
    }
    const meta = json?.ResponseMetadata ?? {};
    const err = meta.Error;
    if (err) {
      if (isAuthError(err.Code) || resp.status === 401 || resp.status === 403) {
        throw upstreamError("unauthorized",
          `ark-quota: 访问密钥校验失败（${err.Code}: ${err.Message}）。请检查 accessKeyId / secretAccessKey。`);
      }
      throw upstreamError("upstream", `ark-quota: OpenAPI error ${err.Code}: ${err.Message}`);
    }
    return json;
  };

  /**
   * 拉取一个账号的额度。
   * @param account - migrateAccounts 输出里的一个条目。
   */
  const refresh = async (account) => {
    const cfg = effective();
    if (!account.accessKeyId || !account.secretAccessKey) {
      throw upstreamError("missing-auth",
        `账号「${account.label}」未配置访问密钥（accessKeyId / secretAccessKey）。请在设置中填写火山引擎访问密钥。`);
    }
    // Coding Plan first; fall back to Agent Plan when coding is not subscribed.
    let raw = await fetchOnce(account, ACTIONS.codingPlan);
    let tiers = parseCodingPlan(raw?.Result);
    let plan = "coding-plan";
    if (tiers.length === 0) {
      raw = await fetchOnce(account, ACTIONS.agentPlan);
      tiers = parseAgentPlan(raw?.Result);
      plan = "agent-plan";
    }
    const payload = shapeResult(tiers, plan, raw?.Result);
    // 两个套餐接口都成功但都没有额度行 → 该账号大概率根本没订阅套餐。
    // 显式打个标记，前端才能把「未订阅」和「上游临时返回空」区分开。
    if (tiers.length === 0) payload.noPlan = true;
    // Tell the browser how often to poll (it must not hardcode the interval —
    // the user can change refreshMs from the Settings card). cachedAt is the
    // moment this payload entered the host cache, so the browser can schedule
    // its next poll to fire shortly AFTER the cache expires (avoiding the
    // equal-interval race where a 5-min client tick hits a not-yet-expired
    // 5-min host cache and serves stale data for another whole interval).
    const nowMs = Date.now();
    payload.refreshMs = cfg.refreshMs; // already snapped by effective()
    payload.cachedAt = nowMs; // milliseconds since epoch — not unix seconds
    // 账号身份随 payload 一起返回：前端切换账号后要能确认拿到的是哪一份。
    payload.accountId = account.id;
    payload.accountLabel = account.label;
    caches.set(account.id, { at: nowMs, payload });
    // 每次真正从上游取到额度就记一次快照：消耗速度完全由这些快照算出。
    recordSnap(account.id, payload.quota);
    return payload;
  };

  /**
   * 单航班刷新：同一账号的并发请求共用一个在途 Promise。
   * 失败时所有等待者一起收到错误（诚实），且不写缓存，下一次请求自然重试。
   */
  const refreshShared = (account) => {
    const existing = inflight.get(account.id);
    if (existing) return existing;
    const job = Promise.resolve()
      .then(() => refresh(account))
      .finally(() => inflight.delete(account.id));
    inflight.set(account.id, job);
    return job;
  };

  /**
   * 一个账号最近观测到的「近1月」已用百分比（不含任何凭据）。
   *
   * 换号建议用：当前账号短期额度告急时，前端要能直接看到哪个账号月度余量
   * 最充足。优先用本会话的上游缓存（最新鲜）；本会话还没拉过该账号时，
   * 退回落盘快照里最新一条观测点（重启后也有数据）。都没有就返回 null。
   */
  const accountMonthlyPct = (id) => {
    const cachedQuota = caches.get(id)?.payload?.quota;
    if (Array.isArray(cachedQuota)) {
      const m = cachedQuota.find((q) => q.level === "monthly");
      if (m && Number.isFinite(m.percentUsed)) return clampPercent(m.percentUsed);
    }
    const snaps = snapState.snapsByAccount?.[id];
    if (Array.isArray(snaps) && snaps.length > 0) {
      const last = snaps[snaps.length - 1];
      const v = last?.p?.monthly;
      // 快照超过 30 小时视为过期（插件长期未开，月度档可能已重置），
      // 过期余量不参与换号建议，宁可不推荐也不推荐一个假的空闲账号。
      if (Number.isFinite(v) && Date.now() - last.t < 30 * 3600 * 1000) {
        return clampPercent(v);
      }
    }
    return null;
  };

  /** 账号清单（不含任何凭据，只有 id / 标签 / 是否已配密钥 / 关联的 provider / 月度水位）。 */
  const accountsSummary = () => {
    const cfg = effective();
    return cfg.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      configured: !!(a.accessKeyId && a.secretAccessKey),
      providers: a.providers.slice(),
      monthlyPct: accountMonthlyPct(a.id)
    }));
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
      const params = new URL(req.url ?? "/", "http://x").searchParams;
      const force = params.get("force") === "1";
      const wanted = params.get("account");
      const account = accountOf(wanted);
      if (account === null) {
        // 一个账号都没配 → 401 + missing-auth，与旧版行为一致（前端据此提示配密钥）。
        const cfg = effective();
        send(cfg.accounts.length === 0 ? 401 : 404, {
          ok: false,
          code: cfg.accounts.length === 0 ? "missing-auth" : "unknown-account",
          message: cfg.accounts.length === 0
            ? "未配置任何火山账号。请在设置 → 方舟额度中添加账号并填写访问密钥。"
            : `未知账号：${JSON.stringify(wanted)}`,
          accounts: accountsSummary()
        });
        return;
      }
      const fresh = !force && cacheFresh(account.id);
      const payload = fresh ? caches.get(account.id).payload : await refreshShared(account);
      // 账号列表与当前账号随每次响应带出：前端不必再单独请求一次。
      // 消耗速度按当前时刻实时算（缓存命中时也要更新预计耗尽时间）。
      send(200, {
        ...payload,
        burn: burnRatesFor(snapState, account.id, payload.quota, Date.now()),
        accounts: accountsSummary(),
        activeAccountId: effective().activeAccountId
      });
    } catch (error) {
      ctx.logger.warn(error);
      // Map proxy failures to honest HTTP statuses (the client reads the JSON
      // body regardless): 401 bad credentials, 504 gateway unreachable, else 502.
      const status = error?.code === "unauthorized" || error?.code === "missing-auth" ? 401
        : error?.code === "network" ? 504
        : 502;
      send(status, {
        ok: false,
        code: error?.code ?? "upstream",
        message: String(error?.message ?? error),
        accounts: accountsSummary()
      });
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota",
    handler
  }), "ark-quota: /ark-quota route");

  // The DSH configuration client (GUI settingsScope) only exposes the
  // platform's own namespaces — third-party namespaces answer
  // `settings-not-exposed` for both reads and writes. Plugin-owned routes are
  // the sanctioned surface (same pattern as dsh-config-sync): these read and
  // write the namespace straight through the host seam, bypassing the proxy
  // allowlist. Neither route ever echoes a credential — only booleans.

  const statusPayload = () => {
    const cfg = effective();
    const accounts = accountsSummary();
    const active = cfg.accounts.find((a) => a.id === cfg.activeAccountId) ?? null;
    return {
      ok: true,
      // 顶层 configured 保持"当前账号是否可用"的语义（旧前端读这个字段）。
      configured: active !== null && !!(active.accessKeyId && active.secretAccessKey),
      accessKeyIdSet: active !== null && !!active.accessKeyId,
      secretAccessKeySet: active !== null && !!active.secretAccessKey,
      refreshMs: cfg.refreshMs,
      accounts,
      activeAccountId: cfg.activeAccountId
    };
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota/status",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, code: "method", message: "GET only" });
        return;
      }
      sendJson(res, 200, statusPayload());
    }
  }), "ark-quota: /ark-quota/status route");

  // 可选的 llm 提供方路由清单：设置界面用它做多选，避免手打路由名打错。
  // 只回 id + 显示名，绝不涉及任何凭据；llm 服务缺席时回空列表而非报错。
  //
  // 默认只列**火山方舟**的路由：这个插件展示的是方舟额度，把第三方中转
  // （sub2api 之类）也列出来只会诱导误配。判定优先看该路由的 baseURL 是否
  // 指向 volces.com / volcengine.com，读不到 baseURL 时退回名称特征。
  // `?all=1` 可以列出全部，供路由名不常规的情况兜底。
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota/providers",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, code: "method", message: "GET only" });
        return;
      }
      let providers = [];
      try {
        const listed = typeof ctx.llm?.listProviders === "function" ? ctx.llm.listProviders() : [];
        providers = listed
          .map((p) => ({ id: String(p?.id ?? ""), name: String(p?.name ?? p?.id ?? "") }))
          .filter((p) => p.id.length > 0);
      } catch (error) {
        ctx.logger.warn(`ark-quota: 读取 llm 提供方列表失败：${String(error?.message ?? error)}`);
      }
      const wantAll = new URL(req.url ?? "/", "http://x").searchParams.get("all") === "1";
      const arkUrls = arkProviderBaseUrls(ctx);
      const total = providers.length;
      // 已被账号占用的路由一并带出，前端可提示"已关联到某账号"。
      const claimed = {};
      for (const a of effective().accounts) {
        for (const p of a.providers) claimed[p] = a.id;
      }
      // 已关联但判定**不是**火山方舟的路由（典型：deepseek-official 这类内置
      // 路由被误勾）：默认列表里不再展示，免得诱导继续误配；但单独带出去，
      // 前端在警告区提示"有 N 个已关联路由不是火山方舟"，用户可在"显示全部"
      // 里取消勾选。只统计当前真实存在的路由（适配器已卸载的不在此列）。
      const byId = new Map(providers.map((p) => [p.id, p]));
      const foreignClaimed = [];
      for (const [id, owner] of Object.entries(claimed)) {
        const p = byId.get(id);
        if (p && !isArkProvider(p, arkUrls)) {
          foreignClaimed.push({ id: p.id, name: p.name, owner });
        }
      }
      if (!wantAll) {
        // 默认只列火山方舟路由：域名是硬证据，读不到 baseURL 时退回名称特征。
        // 注意：已关联不构成保留理由——误关联的非火山路由改由 foreignClaimed 提示。
        providers = providers.filter((p) => isArkProvider(p, arkUrls));
      }
      sendJson(res, 200, {
        ok: true,
        providers,
        claimed,
        foreignClaimed,
        // 让前端能提示"已隐藏 N 个非方舟提供方"，而不是让人以为路由丢了。
        filtered: wantAll ? 0 : total - providers.length,
        totalProviders: total
      });
    }
  }), "ark-quota: /ark-quota/providers route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota/credentials",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, code: "method", message: "POST only" });
        return;
      }
      if (rejectCrossOrigin(req, res)) return;
      if (settingsScope === null) {
        sendJson(res, 503, { ok: false, code: "unavailable", message: "ark-quota 设置命名空间尚未就绪" });
        return;
      }
      const body = await readBody(req);
      if (body._parseError) {
        sendJson(res, 400, { ok: false, code: "parse", message: "请求体不是合法 JSON" });
        return;
      }
      // Fixed-shape write: only the two secret key fields (trimmed non-empty
      // strings). No user-controlled URLs/objects — no SSRF surface.
      const patch = {};
      if (typeof body.accessKeyId === "string" && body.accessKeyId.trim().length > 0) {
        patch.accessKeyId = body.accessKeyId.trim();
      }
      if (typeof body.secretAccessKey === "string" && body.secretAccessKey.trim().length > 0) {
        patch.secretAccessKey = body.secretAccessKey.trim();
      }
      if (Object.keys(patch).length === 0) {
        sendJson(res, 400, { ok: false, code: "noop", message: "没有可写入的访问密钥字段（accessKeyId / secretAccessKey 不能为空）" });
        return;
      }
      // 多账号：密钥写进目标账号，而不是顶层字段。account 缺省时写当前账号；
      // 一个账号都没有时自动建一个（首次配置的顺手路径）。
      const cfg = effective();
      const wanted = str(body.account);
      let accounts = cfg.accounts.map((a) => ({ ...a, providers: a.providers.slice() }));
      let targetId;
      if (accounts.length === 0) {
        targetId = LEGACY_ACCOUNT_ID;
        accounts = [{
          id: targetId,
          label: "默认账号",
          accessKeyId: "",
          secretAccessKey: "",
          region: DEFAULT_REGION,
          version: DEFAULT_VERSION,
          providers: []
        }];
      } else {
        targetId = wanted.length > 0 ? wanted : cfg.activeAccountId;
        if (!accounts.some((a) => a.id === targetId)) {
          sendJson(res, 404, { ok: false, code: "unknown-account", message: `未知账号：${JSON.stringify(wanted)}` });
          return;
        }
      }
      const next = accounts.map((a) => (a.id === targetId ? { ...a, ...patch } : a));
      try {
        await settingsScope.update({ accounts: next, activeAccountId: cfg.activeAccountId ?? targetId });
        // 密钥换了，这个账号的缓存必须作废（其他账号不受影响）。
        caches.delete(targetId);
        ctx.logger.info(`ark-quota: 账号 ${targetId} 的访问密钥已更新`);
        sendJson(res, 200, statusPayload());
      } catch (error) {
        ctx.logger.warn(error);
        sendJson(res, 400, { ok: false, code: "config", message: String(error?.message ?? error) });
      }
    }
  }), "ark-quota: /ark-quota/credentials route");

  // 账号增删改：标签、关联的 provider、删除整个账号。
  // 全部是固定形状的字段，凭据不经过这条路由（走 /credentials）。
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota/accounts",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, code: "method", message: "POST only" });
        return;
      }
      if (rejectCrossOrigin(req, res)) return;
      if (settingsScope === null) {
        sendJson(res, 503, { ok: false, code: "unavailable", message: "ark-quota 设置命名空间尚未就绪" });
        return;
      }
      const body = await readBody(req);
      if (body._parseError) {
        sendJson(res, 400, { ok: false, code: "parse", message: "请求体不是合法 JSON" });
        return;
      }
      const action = str(body.action);
      const id = str(body.id);
      const cfg = effective();
      const accounts = cfg.accounts.map((a) => ({ ...a, providers: a.providers.slice() }));
      let next = accounts;
      let activeId = cfg.activeAccountId;

      if (action === "add") {
        if (!ACCOUNT_ID_RE.test(id)) {
          sendJson(res, 400, {
            ok: false,
            code: "bad-id",
            message: "账号 id 必须是小写字母开头，只含小写字母、数字、下划线（例如 personal、company_2）"
          });
          return;
        }
        if (accounts.some((a) => a.id === id)) {
          sendJson(res, 409, { ok: false, code: "duplicate", message: `账号 id 已存在：${id}` });
          return;
        }
        next = accounts.concat([{
          id,
          label: str(body.label) || id,
          accessKeyId: "",
          secretAccessKey: "",
          region: DEFAULT_REGION,
          version: DEFAULT_VERSION,
          providers: []
        }]);
        // 第一个账号自动成为当前账号。
        if (accounts.length === 0) activeId = id;
      } else if (action === "remove") {
        if (!accounts.some((a) => a.id === id)) {
          sendJson(res, 404, { ok: false, code: "unknown-account", message: `未知账号：${JSON.stringify(id)}` });
          return;
        }
        next = accounts.filter((a) => a.id !== id);
        // 删掉的正好是当前账号 → 回落到剩下的第一个（可能为空）。
        if (activeId === id) activeId = next.length > 0 ? next[0].id : "";
        caches.delete(id);
      } else if (action === "update") {
        const target = accounts.find((a) => a.id === id);
        if (target === undefined) {
          sendJson(res, 404, { ok: false, code: "unknown-account", message: `未知账号：${JSON.stringify(id)}` });
          return;
        }
        const patch = {};
        if (typeof body.label === "string") patch.label = str(body.label) || id;
        if (Array.isArray(body.providers)) {
          // provider 路由名去重 + 去空；不校验是否真实存在（llm 可能还没加载完，
          // 而且用户完全可以先配好路由名再启用那个提供方）。
          const seen = [];
          for (const p of body.providers) {
            const name = str(p);
            if (name.length > 0 && !seen.includes(name)) seen.push(name);
          }
          patch.providers = seen;
        }
        if (Object.keys(patch).length === 0) {
          sendJson(res, 400, { ok: false, code: "noop", message: "没有可更新的字段（label / providers）" });
          return;
        }
        next = accounts.map((a) => (a.id === id ? { ...a, ...patch } : a));
      } else if (action === "activate") {
        if (!accounts.some((a) => a.id === id)) {
          sendJson(res, 404, { ok: false, code: "unknown-account", message: `未知账号：${JSON.stringify(id)}` });
          return;
        }
        activeId = id;
      } else {
        sendJson(res, 400, {
          ok: false,
          code: "bad-action",
          message: "action 必须是 add / remove / update / activate 之一"
        });
        return;
      }

      try {
        await settingsScope.update({ accounts: next, activeAccountId: activeId });
        // 账号删除：它的缓存与快照桶都要清掉，否则同名 id 重建时旧消耗速度
        // 历史会污染新账号（add/update/activate 不动快照）。
        if (action === "remove") {
          caches.delete(id);
          const after = dropAccountSnaps(snapState, id);
          if (after !== snapState) {
            snapState = after;
            scheduleFlush();
          }
        }
        ctx.logger.info(`ark-quota: 账号 ${action} ${id || "-"} 已保存`);
        sendJson(res, 200, statusPayload());
      } catch (error) {
        ctx.logger.warn(error);
        sendJson(res, 400, { ok: false, code: "config", message: String(error?.message ?? error) });
      }
    }
  }), "ark-quota: /ark-quota/accounts route");

  // Non-secret UI preferences (refresh cadence). The settings card writes
  // here; this is a narrow, allowlisted field — never arbitrary objects, no
  // URLs/SSRF surface. Credentials continue to go through /credentials.
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota/settings",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, code: "method", message: "POST only" });
        return;
      }
      if (rejectCrossOrigin(req, res)) return;
      if (settingsScope === null) {
        sendJson(res, 503, { ok: false, code: "unavailable", message: "ark-quota 设置命名空间尚未就绪" });
        return;
      }
      const body = await readBody(req);
      if (body._parseError) {
        sendJson(res, 400, { ok: false, code: "parse", message: "请求体不是合法 JSON" });
        return;
      }
      // Strict allowlist: refreshMs must be one of the fixed cadence choices.
      const raw = Number(body.refreshMs);
      if (!ALLOWED_REFRESH_MS.includes(raw)) {
        sendJson(res, 400, {
          ok: false,
          code: "bad-value",
          message: "refreshMs 必须是 60000 / 300000 / 600000 / 1800000 / 3600000 之一"
        });
        return;
      }
      try {
        await settingsScope.update({ refreshMs: raw });
        ctx.logger.info(`ark-quota: refreshMs updated to ${raw}ms via /ark-quota/settings`);
        sendJson(res, 200, statusPayload());
      } catch (error) {
        ctx.logger.warn(error);
        sendJson(res, 400, { ok: false, code: "config", message: String(error?.message ?? error) });
      }
    }
  }), "ark-quota: /ark-quota/settings route");
}
