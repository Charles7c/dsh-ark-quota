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

export const Config = z.object({
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
  accessKeyId: z.string().role("secret").default(""),
  secretAccessKey: z.string().role("secret").default(""),
  region: z.string().default(DEFAULT_REGION),
  version: z.string().default(DEFAULT_VERSION),
  refreshMs: z.number().min(60000).max(3600000).default(DEFAULT_REFRESH_MS)
});

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
 * 请求统计（路径 A：llm/stream 钩子 + storageDomain 落盘）
 *
 * 方舟的配额 OpenAPI 只返回额度百分比，不返回调用量/成功率/时序，所以这三个
 * 指标改由 DSH 自身的 LLM 调用接缝统计：`ctx.llm` 的 `llm/stream` 是一个
 * waterfall 事件，每次模型调用都会流经它，插件在其中包一层观察者。
 *
 * 判定口径（见 @deepseek-ai/dsh-llm 的流协议）：适配器失败**不抛异常**，而是
 * 以终止 `finish` chunk 送达，`reason.kind` 为 `error` / `aborted`；正常结束是
 * `stop` / `tool-calls` / `max-tokens`。所以成功与否只看终止 chunk，不看异常。
 */
/**
 * 落盘域名。
 *
 * 必须匹配 dsh-storage 的 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`：小写字母开头，
 * 只允许小写字母、数字、下划线，**不能有连字符**。早先写成 `ark-quota-stats`
 * 会让 `storageDomain.open()` 直接抛 `invalid-name`，插件静默退回内存统计
 * （persisted:false），重启后数据全丢。
 */
const STATS_DOMAIN = "ark_quota_stats";
/**
 * 分钟桶保留时长：60 分钟。
 *
 * 这是健康条的观测窗口，按业界 status strip（StatusPage / Better Uptime /
 * GitHub Status）的惯例，窗口要匹配"一次使用会话"的时长：编码会话通常
 * 20~40 分钟，60 分钟窗口能完整覆盖当前会话又不会把点摊得太稀。
 * 早先的 4 小时窗口意味着每点 8 分钟，刚发的请求要等 8 分钟才在点上稳定，
 * 而且大部分点长期是空的，信息密度很低。
 */
const STATS_RETAIN_MS = 60 * 60 * 1000;
/** 健康条点数；每点跨度 = 保留时长 / 点数 = 2 分钟。 */
const STATS_DOTS = 30;
/** 「近 N 分钟」统计窗口。 */
const STATS_RECENT_MS = 30 * 60 * 1000;
/** 落盘节流：突发调用合并成一次写。 */
const STATS_FLUSH_MS = 2000;

/**
 * 单点健康分档阈值（业界 status strip 的通用口径）。
 * ≥99% 正常(operational)、≥95% 降级(degraded)、<95% 故障(outage)。
 */
const STATS_HEALTH_OK = 0.99;
const STATS_HEALTH_DEGRADED = 0.95;

/**
 * 把一个点的成败计数折叠成健康状态。
 *
 * 关键点：状态由**成功率**决定，不是"有没有失败"。8 分钟里 100 次请求挂 1 次
 * （99%）和 1 次请求挂 1 次（0%）是完全不同的健康度，早先按 fail>0 一律标红
 * 把这两种情况画成了同一个颜色。
 *
 * `empty` 是独立状态而不是"健康"：没有样本就是没有观测，既不能算正常也不能
 * 算故障，聚合成功率时必须排除（否则空窗会把成功率稀释或虚高）。
 */
export function dotStatus(ok, fail) {
  const total = ok + fail;
  if (total === 0) return "empty";
  const rate = ok / total;
  if (rate >= STATS_HEALTH_OK) return "ok";
  if (rate >= STATS_HEALTH_DEGRADED) return "degraded";
  return "outage";
}

/** 一个分钟桶：m = 分钟纪元（floor(ms/60000)），ok/fail = 该分钟内的成败数。 */
const StatsBucketSchema = zod.object({
  m: zod.number(),
  ok: zod.number(),
  fail: zod.number()
});

/**
 * 落盘的统计全局态。表集合为空——这个域只有一个单例槽。
 *
 * `inflight` 是后加的字段，声明为 optional 才能读回旧版落盘文件（否则
 * schema 校验失败 → 整个域打不开 → 已有累计量全丢）。落盘的在途数没有
 * 实际意义（进程都退了，请求不可能还在跑），所以读回时一律归零。
 */
const StatsGlobalSchema = zod.object({
  startedAt: zod.number(),
  total: zod.number(),
  ok: zod.number(),
  fail: zod.number(),
  inflight: zod.number().optional(),
  buckets: zod.array(StatsBucketSchema)
});

/** 手写 domain spec：`defineDomain` 只做作者期校验，`open` 会再校验一遍。 */
function statsDomainSpec(nowMs) {
  return {
    name: STATS_DOMAIN,
    version: 1,
    global: {
      schema: StatsGlobalSchema,
      initial: { startedAt: nowMs, total: 0, ok: 0, fail: 0, inflight: 0, buckets: [] }
    },
    tables: {}
  };
}

/** 丢掉超出保留窗口的分钟桶（就地返回新数组，不改原对象）。 */
export function pruneBuckets(buckets, nowMs) {
  const oldest = Math.floor((nowMs - STATS_RETAIN_MS) / 60000);
  return buckets.filter((b) => b.m >= oldest);
}

/**
 * 记一次调用结果到统计态，返回新的统计态（纯函数，便于测试）。
 *
 * 口径说明（这里曾经导致「总数 18 / 近 30 分钟 17」的观感 bug）：
 * `total` 在请求**开始**时就 +1，而分钟桶只在请求**结束**时才落账，因为一个
 * 流式请求的成败要等终止 chunk 才知道。于是流式输出进行中的那一刻，
 * total 已经算了它、桶还没有——并排展示的两个数字就差 1。
 *
 * 解决办法不是把 total 推迟到结束（那样"发出去了却没计数"更违反直觉），
 * 而是显式跟踪 `inflight`：开始 +1、结束 -1，让 `recent` 把进行中的请求
 * 一起算进来，两个数字口径就一致了。
 * @param state - 当前统计态。
 * @param outcome - `start` 增总数与在途数；`ok` / `fail` 记终局并减在途数。
 * @param nowMs - 当前时刻。
 */
export function foldStats(state, outcome, nowMs) {
  const minute = Math.floor(nowMs / 60000);
  const buckets = pruneBuckets(state.buckets, nowMs);
  const inflight = state.inflight ?? 0;
  const next = {
    startedAt: state.startedAt,
    total: state.total + (outcome === "start" ? 1 : 0),
    ok: state.ok + (outcome === "ok" ? 1 : 0),
    fail: state.fail + (outcome === "fail" ? 1 : 0),
    // 结束时减 1，但不能减到负数：进程重启后落盘的 inflight 可能是脏的
    // （上次退出时有请求正在跑），此时先到的"结束"事件没有对应的"开始"。
    inflight: outcome === "start" ? inflight + 1 : Math.max(0, inflight - 1),
    buckets
  };
  if (outcome === "start") return next;
  const last = buckets.length > 0 ? buckets[buckets.length - 1] : null;
  const delta = outcome === "ok" ? { ok: 1, fail: 0 } : { ok: 0, fail: 1 };
  if (last !== null && last.m === minute) {
    buckets[buckets.length - 1] = { m: minute, ok: last.ok + delta.ok, fail: last.fail + delta.fail };
  } else {
    buckets.push({ m: minute, ok: delta.ok, fail: delta.fail });
  }
  return next;
}

/**
 * 把分钟桶折叠成对外的统计视图：总数、成功率、近 30 分钟、健康条。
 *
 * 健康条按业界 status strip 的口径产出：每点带自己的成功率与分档状态，
 * 空点单独标记且不参与窗口成功率；窗口成功率只由**有样本**的点决定。
 * @param state - 统计态。
 * @param nowMs - 当前时刻。
 */
export function shapeStats(state, nowMs) {
  const buckets = pruneBuckets(state.buckets, nowMs);
  const finished = state.ok + state.fail;
  const inflight = state.inflight ?? 0;
  const recentFloor = Math.floor((nowMs - STATS_RECENT_MS) / 60000);
  let recentFinished = 0;
  for (const b of buckets) {
    if (b.m >= recentFloor) recentFinished += b.ok + b.fail;
  }
  // 「近 30 分钟」= 已完成 + 正在进行。分钟桶只在请求结束时落账，若只数桶，
  // 流式输出进行中的请求会缺席，与"请求总数（开始即计数）"差 1。
  const recent = recentFinished + inflight;
  // 健康条：末尾对齐当前分钟，每点 2 分钟，共 30 点（覆盖 60 分钟）。
  const dotMinutes = STATS_RETAIN_MS / 60000 / STATS_DOTS;
  const endMinute = Math.floor(nowMs / 60000) + 1;
  const dots = [];
  for (let i = STATS_DOTS - 1; i >= 0; i -= 1) {
    const to = endMinute - i * dotMinutes;
    const from = to - dotMinutes;
    let ok = 0;
    let fail = 0;
    for (const b of buckets) {
      if (b.m >= from && b.m < to) {
        ok += b.ok;
        fail += b.fail;
      }
    }
    const total = ok + fail;
    dots.push({
      startMs: from * 60000,
      spanMs: dotMinutes * 60000,
      ok,
      fail,
      // 每点自带成功率与分档：客户端只负责取色，不再自己判定口径。
      rate: total > 0 ? ok / total : null,
      status: dotStatus(ok, fail)
    });
  }
  // 健康窗口 = min(统计存续时长, 桶保留时长)：统计刚开没多久时显示真实跨度。
  const windowMs = Math.max(0, Math.min(nowMs - state.startedAt, STATS_RETAIN_MS));
  // 窗口聚合只累计有样本的点：空窗不该把成功率稀释或虚高。
  let windowOk = 0;
  let windowFail = 0;
  let sampled = 0;
  for (const d of dots) {
    if (d.status === "empty") continue;
    sampled += 1;
    windowOk += d.ok;
    windowFail += d.fail;
  }
  const windowFinished = windowOk + windowFail;
  return {
    startedAt: state.startedAt,
    total: state.total,
    // 字段名刻意不叫 ok/fail：路由 payload 已经用 `ok: true` 表示请求成功，
    // 同名会被覆盖成布尔值（这个坑踩过一次）。
    succeeded: state.ok,
    failed: state.fail,
    rate: finished > 0 ? state.ok / finished : null,
    recent,
    recentMs: STATS_RECENT_MS,
    // 正在进行的请求数：前端据此在数字旁提示"其中 N 个进行中"。
    inflight,
    windowMs,
    windowRate: windowFinished > 0 ? windowOk / windowFinished : null,
    // 有样本的点数：客户端用它区分"全绿"和"根本没数据"。
    windowSampledDots: sampled,
    dotSpanMs: dotMinutes * 60000,
    dots
  };
}

export function apply(ctx, config) {
  const base = {
    accessKeyId: config.accessKeyId || "",
    secretAccessKey: config.secretAccessKey || "",
    region: config.region || DEFAULT_REGION,
    version: config.version || DEFAULT_VERSION,
    refreshMs: normalizeRefreshMs(config.refreshMs ?? DEFAULT_REFRESH_MS)
  };

  let settingsScope = null;
  let cache = null; // { at, payload }

  // Register the settings namespace; the user layer (settings.yaml / GUI)
  // overrides the patch `base`. Watchers drop the cache so an AK/SK change
  // applies on the next request without a restart.
  ctx.effect(() => {
    const scope = ctx.settings.register(ARK_QUOTA_NS, SettingsSchema, { base });
    settingsScope = scope;
    const unwatch = scope.watch(() => {
      cache = null;
      ctx.logger.info("ark-quota: settings changed — cache reset");
    });
    return () => {
      unwatch();
      settingsScope = null;
    };
  }, "ark-quota: settings namespace");

  /** The effective config: settings scope when mounted, else the patch base. */
  const effective = () => {
    const cfg = settingsScope !== null ? settingsScope.get() : base;
    return { ...cfg, refreshMs: normalizeRefreshMs(cfg.refreshMs) };
  };

  // ── 请求统计：落盘态 + llm/stream 观察者 ────────────────────────────────
  // 内存态是权威读端，落盘只是重启后的续命。域打开前先用初始态记账，
  // 打开成功后把已记的量并入落盘值（不丢启动瞬间的调用）。
  let stats = { startedAt: Date.now(), total: 0, ok: 0, fail: 0, inflight: 0, buckets: [] };
  let statsDomain = null;
  let statsTimer = null;
  let statsDirty = false;
  // 落盘不可用的原因；非 null 时通过 /ark-quota/stats 暴露给前端，
  // 免得"重启后数据全空"只能靠翻日志才能诊断。
  let statsPersistError = null;

  /** 落盘用的快照：在途数不跨进程，写 0 让文件本身也是自洽的。 */
  const statsSnapshot = () => ({ ...stats, inflight: 0 });

  const flushStats = () => {
    statsTimer = null;
    if (statsDomain === null || !statsDirty) return;
    statsDirty = false;
    // 落盘失败不能影响读端：内存态已是权威，但要留下可见的原因。
    Promise.resolve(statsDomain.global.set(statsSnapshot())).catch((error) => {
      statsPersistError = `写入失败：${String(error?.message ?? error)}`;
      ctx.logger.error(`ark-quota: 统计落盘失败：${String(error?.message ?? error)}`);
    });
  };

  const scheduleFlush = () => {
    statsDirty = true;
    if (statsTimer !== null || statsDomain === null) return;
    statsTimer = setTimeout(flushStats, STATS_FLUSH_MS);
    if (typeof statsTimer?.unref === "function") statsTimer.unref();
  };

  const recordStats = (outcome) => {
    stats = foldStats(stats, outcome, Date.now());
    scheduleFlush();
  };

  ctx.effect(() => {
    if (ctx.storageDomain === undefined || typeof ctx.storageDomain.open !== "function") {
      statsPersistError = "storageDomain 服务不可用（宿主未加载 storage-domain 插件）";
      ctx.logger.info("ark-quota: storageDomain 不可用，请求统计仅存于内存");
      return () => {};
    }
    let opened = null;
    Promise.resolve(ctx.storageDomain.open(statsDomainSpec(Date.now())))
      .then((domain) => {
        opened = domain;
        statsDomain = domain;
        statsPersistError = null;
        const stored = domain.global.get();
        // 合并：落盘的累计量 + 域打开前这段时间已记的量。
        // `inflight` 只取内存值：落盘的在途数属于上一个进程，那些请求早就
        // 随进程一起消失了，累加进来会让"近 30 分钟"永久虚高。
        stats = {
          startedAt: Math.min(stored.startedAt, stats.startedAt),
          total: stored.total + stats.total,
          ok: stored.ok + stats.ok,
          fail: stored.fail + stats.fail,
          inflight: stats.inflight,
          buckets: pruneBuckets(stored.buckets.concat(stats.buckets), Date.now())
        };
        ctx.logger.info(`ark-quota: 统计域已打开（累计 ${stats.total} 次请求）`);
        if (statsDirty) scheduleFlush();
      })
      .catch((error) => {
        // 这里曾经只记 warn，导致域名不合法这种硬错误被静默吞掉。
        statsPersistError = String(error?.message ?? error);
        ctx.logger.error(
          `ark-quota: 统计域打开失败，退回内存统计（重启会丢数据）：${statsPersistError}`
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
      Promise.resolve(domain.global.set(statsSnapshot()))
        .catch(() => {})
        .then(() => domain.close())
        .catch(() => {});
    };
  }, "ark-quota: 请求统计域");

  ctx.effect(() => {
    if (typeof ctx.on !== "function") {
      ctx.logger.info("ark-quota: 无事件接缝，跳过 llm/stream 统计");
      return () => {};
    }
    // waterfall 监听者：必须返回 AsyncIterable，所以包一层透传生成器，
    // 边转发 chunk 边观察终止原因，绝不改写或吞掉任何 chunk。
    return ctx.on("llm/stream", (options, next) => {
      recordStats("start");
      const inner = next();
      return (async function* observed() {
        // 没见到终止 chunk（消费者提前退出、迭代抛错）一律记失败。
        let outcome = "fail";
        try {
          for await (const chunk of inner) {
            if (chunk !== null && typeof chunk === "object" && chunk.type === "finish") {
              const kind = chunk.reason?.kind;
              outcome = kind === "error" || kind === "aborted" ? "fail" : "ok";
            }
            yield chunk;
          }
        } finally {
          recordStats(outcome);
        }
      })();
    });
  }, "ark-quota: llm/stream 统计钩子");

  const cacheFresh = () => cache !== null && Date.now() - cache.at < effective().refreshMs;

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

  const refresh = async () => {
    const cfg = effective();
    if (!cfg.accessKeyId || !cfg.secretAccessKey) {
      throw upstreamError("missing-auth",
        "未配置访问密钥（accessKeyId / secretAccessKey）。请在设置或 cordis.patch.yml 中填写火山引擎访问密钥。");
    }
    // Coding Plan first; fall back to Agent Plan when coding is not subscribed.
    let raw = await fetchOnce(cfg, ACTIONS.codingPlan);
    let tiers = parseCodingPlan(raw?.Result);
    let plan = "coding-plan";
    if (tiers.length === 0) {
      raw = await fetchOnce(cfg, ACTIONS.agentPlan);
      tiers = parseAgentPlan(raw?.Result);
      plan = "agent-plan";
    }
    const payload = shapeResult(tiers, plan, raw?.Result);
    // Tell the browser how often to poll (it must not hardcode the interval —
    // the user can change refreshMs from the Settings card). cachedAt is the
    // moment this payload entered the host cache, so the browser can schedule
    // its next poll to fire shortly AFTER the cache expires (avoiding the
    // equal-interval race where a 5-min client tick hits a not-yet-expired
    // 5-min host cache and serves stale data for another whole interval).
    const nowMs = Date.now();
    payload.refreshMs = cfg.refreshMs; // already snapped by effective()
    payload.cachedAt = nowMs; // milliseconds since epoch — not unix seconds
    cache = { at: nowMs, payload };
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
      // body regardless): 401 bad credentials, 504 gateway unreachable, else 502.
      const status = error?.code === "unauthorized" || error?.code === "missing-auth" ? 401
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

  // The DSH configuration client (GUI settingsScope) only exposes the
  // platform's own namespaces — third-party namespaces answer
  // `settings-not-exposed` for both reads and writes. Plugin-owned routes are
  // the sanctioned surface (same pattern as dsh-config-sync): these read and
  // write the namespace straight through the host seam, bypassing the proxy
  // allowlist. Neither route ever echoes a credential — only booleans.

  const statusPayload = () => {
    const cfg = effective();
    return {
      ok: true,
      configured: !!(cfg.accessKeyId && cfg.secretAccessKey),
      accessKeyIdSet: !!cfg.accessKeyId,
      secretAccessKeySet: !!cfg.secretAccessKey,
      refreshMs: cfg.refreshMs
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

  // 请求统计只读视图：不含任何凭据，也不触发上游调用，纯内存折叠。
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota/stats",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, code: "method", message: "GET only" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        persisted: statsDomain !== null,
        // 落盘不可用时把原因带出来：前端可提示"重启会丢数据"，不必翻日志。
        persistError: statsPersistError,
        ...shapeStats(stats, Date.now())
      });
    }
  }), "ark-quota: /ark-quota/stats route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota/credentials",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, code: "method", message: "POST only" });
        return;
      }
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
      try {
        await settingsScope.update(patch);
        ctx.logger.info("ark-quota: credentials updated via /ark-quota/credentials");
        sendJson(res, 200, statusPayload());
      } catch (error) {
        ctx.logger.warn(error);
        sendJson(res, 400, { ok: false, code: "config", message: String(error?.message ?? error) });
      }
    }
  }), "ark-quota: /ark-quota/credentials route");

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
