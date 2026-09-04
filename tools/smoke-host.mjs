#!/usr/bin/env node
// Host-half smoke test: mock ctx + stub fetch, no listening server.
import { Readable } from "node:stream";
import { apply, normalizeRefreshMs, ALLOWED_REFRESH_MS, foldStats, shapeStats, pruneBuckets, dotStatus } from "../lib/index.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

function makeReq(method, url, json) {
  const text = json === undefined ? "" : JSON.stringify(json);
  const req = Readable.from([Buffer.from(text)]);
  req.method = method;
  req.url = url;
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: undefined,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ?? "";
    }
  };
}

function mockCtx(opts = {}) {
  const routes = new Map();
  const listeners = new Map(); // event name → Set<fn>
  let stored = opts.stored === undefined ? null : opts.stored;
  let openedSpec = null;
  // 与 dsh-storage 的 UNIT_NAME_RE 保持一致。先前的 mock 接受任何域名，
  // 于是 `ark-quota-stats`（含连字符）在测试里一路绿灯、到了真机才炸：
  // open() 抛错 → 静默退回内存统计 → 重启数据全丢。
  const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
  const storageDomain = {
    async open(spec) {
      if (!UNIT_NAME_RE.test(spec.name)) {
        throw new Error(`invalid-name: domain '${spec.name}' must match ${UNIT_NAME_RE}`);
      }
      for (const table of Object.keys(spec.tables || {})) {
        if (!UNIT_NAME_RE.test(table)) {
          throw new Error(`invalid-name: table '${table}' must match ${UNIT_NAME_RE}`);
        }
      }
      // 全局 schema 不得接受 null（storage-domain 的硬约束）。
      if (spec.global !== undefined && spec.global.schema.safeParse(null).success) {
        throw new Error("global schema must not accept null");
      }
      openedSpec = spec;
      if (stored === null) stored = spec.global.initial;
      return {
        name: spec.name,
        global: {
          get() { return stored; },
          async set(v) { stored = v; }
        },
        async close() {}
      };
    }
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { fn(); },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
    async fireWaterfall(name, ...args) {
      const fns = Array.from(listeners.get(name) || []);
      let i = 0;
      const next = () => {
        if (i >= fns.length) return args[args.length - 1]();
        const fn = fns[i++];
        return fn(...args.slice(0, -1), next);
      };
      return next();
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      }
    },
    settings: {
      register(_ns, _schema, { base }) {
        let current = { ...base };
        const watchers = [];
        return {
          get: () => current,
          watch(cb) {
            watchers.push(cb);
            return () => {};
          },
          async update(patch) {
            current = { ...current, ...patch };
            for (const w of watchers) w();
          }
        };
      }
    },
    storageDomain: opts.storageDomain === false ? undefined : storageDomain,
    __routes: routes,
    __openedSpec: () => openedSpec,
    __stored: () => stored
  };
  return ctx;
}

async function call(ctx, path, method, url, json) {
  const route = ctx.__routes.get(path);
  if (!route) throw new Error(`missing route ${path}`);
  const req = makeReq(method, url ?? path, json);
  const res = makeRes();
  await route.handler(req, res);
  const parsed = res.body ? JSON.parse(res.body) : null;
  return { res, json: parsed };
}

const codingBody = {
  ResponseMetadata: {},
  Result: {
    Status: "Normal",
    UpdateTimestamp: Math.floor(Date.now() / 1000) - 600,
    HasReward: false,
    QuotaUsage: [
      { Level: "monthly", Percent: 150, ResetTime: Math.floor(Date.now() / 1000) + 3600, Used: 12, Total: 100 },
      { Level: "weekly", Percent: -3, ResetTime: Math.floor(Date.now() / 1000) + 3600 },
      { Level: "session", Percent: 40, ResetTime: Math.floor(Date.now() / 1000) + 3600 }
    ]
  }
};

// --- normalizeRefreshMs ---
assert(normalizeRefreshMs(300000) === 300000, "exact 5min cadence passes through");
assert(normalizeRefreshMs(1000) === 60000, "1s YAML snaps to 1min, not an upstream hammer");
assert(normalizeRefreshMs(120000) === 60000, "2min snaps to nearest allowlisted 1min");
assert(normalizeRefreshMs(NaN) === 300000, "NaN falls back to default 5min");
assert(ALLOWED_REFRESH_MS.length === 5, "allowlist has five UI choices");

// --- missing keys ---
{
  const ctx = mockCtx();
  apply(ctx, { accessKeyId: "", secretAccessKey: "", region: "cn-beijing", version: "2024-01-01", refreshMs: 300000 });
  const { res, json } = await call(ctx, "/ark-quota", "GET", "/ark-quota");
  assert(res.statusCode === 401 && json.code === "missing-auth", "missing keys → 401 missing-auth");
  assert(!Object.prototype.hasOwnProperty.call(json, "secretAccessKey"), "error body has no secretAccessKey field");
}

// --- /ark-quota/settings allowlist ---
{
  const ctx = mockCtx();
  apply(ctx, { accessKeyId: "", secretAccessKey: "", region: "cn-beijing", version: "2024-01-01", refreshMs: 1000 });
  const snapped = await call(ctx, "/ark-quota/status", "GET", "/ark-quota/status");
  assert(snapped.json.refreshMs === 60000, "apply() snaps refreshMs=1000 → 60000 in status");
  const get = await call(ctx, "/ark-quota/settings", "GET", "/ark-quota/settings");
  assert(get.res.statusCode === 405, "GET /ark-quota/settings → 405");
  const bad = await call(ctx, "/ark-quota/settings", "POST", "/ark-quota/settings", { refreshMs: 1000 });
  assert(bad.res.statusCode === 400 && bad.json.code === "bad-value", "POST refreshMs=1000 rejected");
  const extra = await call(ctx, "/ark-quota/settings", "POST", "/ark-quota/settings", { refreshMs: 60000, accessKeyId: "nope" });
  assert(extra.res.statusCode === 200 && extra.json.refreshMs === 60000, "POST 1min accepted; extra fields ignored");
  assert(extra.json.accessKeyIdSet === false, "settings route does not echo/set keys");
  const status = await call(ctx, "/ark-quota/status", "GET", "/ark-quota/status");
  assert(status.json.refreshMs === 60000, "status reflects snapped+saved refreshMs");
  // config 1000 was snapped in apply() base before the POST
}

// --- credentials save preserves refreshMs in statusPayload ---
{
  const ctx = mockCtx();
  apply(ctx, { accessKeyId: "", secretAccessKey: "", region: "cn-beijing", version: "2024-01-01", refreshMs: 1800000 });
  const saved = await call(ctx, "/ark-quota/credentials", "POST", "/ark-quota/credentials", {
    accessKeyId: "test-ak-id",
    secretAccessKey: "test-sk"
  });
  assert(saved.res.statusCode === 200, "credentials POST 200");
  assert(saved.json.configured === true, "configured true");
  assert(saved.json.refreshMs === 1800000, "credentials response keeps refreshMs");
  assert(saved.json.accessKeyId == null && saved.json.secretAccessKey == null, "no secret echo");
}

// --- quota payload: clamp + cachedAt ms + cache ---
{
  let fetches = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return {
      status: 200,
      async text() { return JSON.stringify(codingBody); }
    };
  };
  try {
    const ctx = mockCtx();
    apply(ctx, {
      accessKeyId: "test-ak-id",
      secretAccessKey: "test-sk",
      region: "cn-beijing",
      version: "2024-01-01",
      refreshMs: 300000
    });
    const first = await call(ctx, "/ark-quota", "GET", "/ark-quota");
    assert(first.res.statusCode === 200 && first.json.ok === true, "quota GET 200");
    const monthly = first.json.quota.find((q) => q.level === "monthly");
    const weekly = first.json.quota.find((q) => q.level === "weekly");
    assert(monthly.percentUsed === 100, "percentUsed clamped to 100");
    assert(monthly.percentRemaining === 0, "percentRemaining follows clamped used");
    assert(weekly.percentUsed === 0, "negative percentUsed clamped to 0");
    assert(typeof first.json.cachedAt === "number" && first.json.cachedAt > 1e12, "cachedAt is epoch milliseconds");
    assert(first.json.refreshMs === 300000, "payload.refreshMs is allowlisted");
    const head = await call(ctx, "/ark-quota", "HEAD", "/ark-quota");
    assert(head.res.statusCode === 200 && head.res.body === "", "HEAD has no body");
    const second = await call(ctx, "/ark-quota", "GET", "/ark-quota");
    assert(fetches === 1, "second GET served from cache (one upstream call)");
    assert(second.json.cachedAt === first.json.cachedAt, "cached response keeps original cachedAt");
  } finally {
    globalThis.fetch = orig;
  }
}

// --- resetAt / updatedAt unit normalization ---
// The console is not self-consistent: GetCodingPlanUsage returns epoch SECONDS
// while GetAFPUsage returns MILLISECONDS. Feeding ms into the client's
// seconds-based formatter rendered "20678903 天后重置", so toEpochSeconds()
// pins the unit at the parse boundary.
{
  const RESET_S = Math.floor(Date.now() / 1000) + 3 * 3600;
  const RESET_MS = RESET_S * 1000;
  const orig = globalThis.fetch;
  const stub = (body) => {
    globalThis.fetch = async () => ({ status: 200, async text() { return JSON.stringify(body); } });
  };
  const creds = {
    accessKeyId: "test-ak-id",
    secretAccessKey: "test-sk",
    region: "cn-beijing",
    version: "2024-01-01",
    refreshMs: 300000
  };
  const quotaOnce = async (body) => {
    stub(body);
    const ctx = mockCtx();
    apply(ctx, creds);
    return (await call(ctx, "/ark-quota", "GET", "/ark-quota")).json;
  };

  try {
    // Agent Plan: milliseconds upstream must land as seconds.
    const afp = await quotaOnce({
      Result: { AFPFiveHour: { Quota: 100, Used: 25, ResetTime: RESET_MS } }
    });
    const session = afp.quota.find((q) => q.level === "session");
    assert(session.resetAt === RESET_S, "agent-plan ms ResetTime normalized to seconds");
    const days = Math.floor((session.resetAt * 1000 - Date.now()) / 86400000);
    assert(days === 0, "agent-plan reset is hours away, not ~20678903 days");

    // Coding Plan: seconds upstream must pass through untouched.
    const coding = await quotaOnce({
      Result: { QuotaUsage: [{ Level: "weekly", Percent: 40, ResetTime: RESET_S }] } });
    assert(coding.quota[0].resetAt === RESET_S, "coding-plan seconds ResetTime unchanged");

    // The core invariant: the same instant in either unit agrees.
    const asMs = await quotaOnce({
      Result: { QuotaUsage: [{ Level: "weekly", Percent: 40, ResetTime: RESET_MS }] } });
    assert(asMs.quota[0].resetAt === coding.quota[0].resetAt, "either unit → identical resetAt");

    // Absent/zero/non-numeric must stay null (never a 1970 fallback).
    const junk = await quotaOnce({
      Result: { QuotaUsage: [
        { Level: "weekly", Percent: 40 },
        { Level: "monthly", Percent: 10, ResetTime: 0 },
        { Level: "session", Percent: 10, ResetTime: "soon" }
      ] }
    });
    assert(junk.quota.every((q) => q.resetAt === null), "missing/zero/non-numeric ResetTime → null");

    // ResetTimestamp alias and UpdateTimestamp go through the same gate.
    const alias = await quotaOnce({
      Result: { QuotaUsage: [{ Level: "weekly", Percent: 40, ResetTimestamp: RESET_MS }] } });
    assert(alias.quota[0].resetAt === RESET_S, "ResetTimestamp alias ms normalized");
    const updated = await quotaOnce({
      Result: { UpdateTimestamp: RESET_MS, QuotaUsage: [{ Level: "weekly", Percent: 1 }] } });
    assert(updated.updatedAt === RESET_S, "updatedAt ms UpdateTimestamp normalized");
  } finally {
    globalThis.fetch = orig;
  }
}

// --- 统计纯函数：foldStats / shapeStats / pruneBuckets ---
{
  const T0 = 1_700_000_000_000;
  const base = { startedAt: T0, total: 0, ok: 0, fail: 0, buckets: [] };
  // 起步：连续 3 个成功
  let s = base;
  s = foldStats(s, "start", T0);
  s = foldStats(s, "ok", T0 + 5000);
  s = foldStats(s, "start", T0 + 65_000);
  s = foldStats(s, "ok", T0 + 70_000);
  s = foldStats(s, "start", T0 + 125_000);
  s = foldStats(s, "fail", T0 + 130_000);
  assert(s.total === 3, "foldStats: 三次 start → total=3");
  assert(s.ok === 2 && s.fail === 1, "foldStats: 2 成功 1 失败");
  assert(s.buckets.length >= 2, "foldStats: 跨分钟产生多个桶");
  assert(s.buckets[0].ok + s.buckets[1].ok === 2, "foldStats: 成功数按桶拆分");
  // pruneBuckets：观测窗口（60 分钟）之外的桶被清掉
  const nowMin = Math.floor(T0 / 60000);
  const pruned = pruneBuckets([
    { m: nowMin - 90, ok: 1, fail: 0 }, // 90 分钟前 → 裁掉
    { m: nowMin - 10, ok: 1, fail: 0 }  // 10 分钟前 → 保留
  ], T0);
  assert(pruned.length === 1 && pruned[0].m === nowMin - 10, "pruneBuckets: 超出 60 分钟窗口的桶被裁掉");
  // shapeStats：近 30 分钟 + 健康条折叠
  const shaped = shapeStats(s, T0 + 180_000);
  assert(shaped.total === 3, "shapeStats: total 透传");
  assert(typeof shaped.rate === "number" && shaped.rate > 0.5, "shapeStats: rate 为数值");
  assert(shaped.recent >= 3, "shapeStats: 近 30 分钟包含全部请求");
  assert(Array.isArray(shaped.dots) && shaped.dots.length === 30, "shapeStats: 30 个健康点");
  assert(shaped.dotSpanMs === 120000, "shapeStats: 每格 2 分钟（60 分钟 / 30 格）");
  // 每个点都带分档与自身成功率
  assert(shaped.dots.every((d) => typeof d.status === "string"), "shapeStats: 每格带 status 分档");
  const sampledDots = shaped.dots.filter((d) => d.status !== "empty");
  assert(sampledDots.length === shaped.windowSampledDots, "shapeStats: windowSampledDots 等于有样本格数");
  assert(sampledDots.every((d) => typeof d.rate === "number"), "shapeStats: 有样本的格带成功率");
  assert(shaped.dots.filter((d) => d.status === "empty").every((d) => d.rate === null), "shapeStats: 空格成功率为 null");
}

// --- dotStatus：分档按成功率，不是「有没有失败」 ---
{
  // 这是先前实现的核心缺陷：fail>0 一律标红，让 99% 和 0% 同色。
  assert(dotStatus(100, 1) === "ok", "100 次挂 1 次（99.0%）判为正常，不是故障");
  assert(dotStatus(1, 1) === "outage", "1 次挂 1 次（50%）判为故障");
  assert(dotStatus(0, 0) === "empty", "没有样本判为无数据，不参与健康度");
  assert(dotStatus(10, 0) === "ok", "全成功判为正常");
  // 阈值边界：≥99% 正常、≥95% 降级、<95% 故障
  assert(dotStatus(99, 1) === "ok", "99% 命中正常档下界");
  assert(dotStatus(97, 3) === "degraded", "97% 落在降级档");
  assert(dotStatus(95, 5) === "degraded", "95% 命中降级档下界");
  assert(dotStatus(94, 6) === "outage", "94% 跌入故障档");
}

// --- llm/stream 钩子：成功/失败都能被统计到 ---
{
  const ctx = mockCtx();
  apply(ctx, { accessKeyId: "x", secretAccessKey: "y", region: "cn-beijing", version: "2024-01-01", refreshMs: 300000 });
  // 一次成功的流
  async function* successStream() {
    yield { type: "content-delta" };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  const result1 = await ctx.fireWaterfall("llm/stream", { model: "test" }, () => successStream());
  const chunks1 = [];
  for await (const c of result1) chunks1.push(c);
  assert(chunks1.length === 2 && chunks1[1].reason.kind === "stop", "llm/stream: 成功流透传");
  // 一次失败的流（finish 里带 error）
  async function* failStream() {
    yield { type: "content-delta" };
    yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT" } } };
  }
  const result2 = await ctx.fireWaterfall("llm/stream", { model: "test" }, () => failStream());
  const chunks2 = [];
  for await (const c of result2) chunks2.push(c);
  assert(chunks2[chunks2.length - 1].reason.kind === "error", "llm/stream: 失败流透传");
  // 等落盘节流窗口（2s）过去，确认写入了
  await new Promise((r) => setTimeout(r, 2100));
  // stats 路由返回正确的数字
  const { json: stats } = await call(ctx, "/ark-quota/stats", "GET", "/ark-quota/stats");
  assert(stats.ok === true && stats.total === 2, "/ark-quota/stats: total 与钩子计数一致");
  assert(stats.succeeded === 1 && stats.failed === 1, "/ark-quota/stats: 成功/失败数量正确");
  assert(stats.rate === 0.5, "/ark-quota/stats: 成功率 = 50%");
  assert(stats.dots.length === 30, "/ark-quota/stats: 30 个健康点");
  // 最后一个点应包含刚才两次调用，并且按 50% 成功率判为故障档
  const lastDot = stats.dots[stats.dots.length - 1];
  assert(lastDot.ok === 1 && lastDot.fail === 1, "/ark-quota/stats: 最后一个点含本次成败");
  assert(lastDot.status === "outage" && lastDot.rate === 0.5, "/ark-quota/stats: 该点按 50% 判为故障档");
  // 窗口成功率只由有样本的格决定：29 个空格不能把 50% 稀释掉
  assert(stats.windowSampledDots === 1, "/ark-quota/stats: 只有 1 格有样本");
  assert(stats.windowRate === 0.5, "/ark-quota/stats: 窗口成功率排除空格后仍是 50%");
  // persisted = true 意味着 storageDomain 被打开了
  assert(stats.persisted === true, "/ark-quota/stats: persisted 标志为 true");
  // 落盘文件里也有内容
  const stored = ctx.__stored();
  assert(stored !== null && stored.total === 2, "storageDomain: 统计已写入落盘态");
}

// --- storageDomain 不可用时降级为内存统计，不报错 ---
{
  const ctx = mockCtx({ storageDomain: false });
  apply(ctx, { accessKeyId: "x", secretAccessKey: "y", region: "cn-beijing", version: "2024-01-01", refreshMs: 300000 });
  async function* s() { yield { type: "finish", reason: { kind: "stop" } }; }
  const result = await ctx.fireWaterfall("llm/stream", { model: "test" }, () => s());
  for await (const _ of result) { /* 吃掉 */ }
  const { json } = await call(ctx, "/ark-quota/stats", "GET", "/ark-quota/stats");
  assert(json.ok === true && json.total === 1, "降级：无 storageDomain 也能统计");
  assert(json.succeeded === 1, "降级：成功数正确");
  assert(json.persisted === false, "降级：persisted 为 false");
  assert(typeof json.persistError === "string" && json.persistError.length > 0, "降级：路由带出不可用原因");
}

// --- 落盘回归：域名必须过 UNIT_NAME_RE，否则重启数据全丢 ---
{
  const ctx = mockCtx();
  apply(ctx, { accessKeyId: "x", secretAccessKey: "y", region: "cn-beijing", version: "2024-01-01", refreshMs: 300000 });
  await new Promise((r) => setTimeout(r, 20));
  const spec = ctx.__openedSpec();
  // 这条断言就是"重启后全空"那个 bug 的守卫：`ark-quota-stats` 含连字符，
  // dsh-storage 的 UNIT_NAME_RE 会拒掉，open() 抛错后插件静默退回内存统计。
  assert(spec !== null, "统计域成功打开（域名合法）");
  assert(/^[a-z][a-z0-9_]*$/.test(spec.name), `域名 '${spec?.name}' 符合 UNIT_NAME_RE（不含连字符）`);
  assert(!spec.name.includes("-"), "域名不含连字符");
  const { json } = await call(ctx, "/ark-quota/stats", "GET", "/ark-quota/stats");
  assert(json.persisted === true, "域打开后 persisted 为 true");
  assert(json.persistError === null, "域正常时不报错");
}

// --- 重启恢复：落盘的累计量要被读回来，并与启动瞬间的调用合并 ---
{
  const T = Date.now();
  // 模拟"上次运行留下的落盘态"：累计 100 次，其中 98 成功。
  const prior = {
    startedAt: T - 20 * 60 * 1000,
    total: 100,
    ok: 98,
    fail: 2,
    buckets: [{ m: Math.floor(T / 60000) - 5, ok: 3, fail: 0 }]
  };
  const ctx = mockCtx({ stored: prior });
  apply(ctx, { accessKeyId: "x", secretAccessKey: "y", region: "cn-beijing", version: "2024-01-01", refreshMs: 300000 });
  // 域是异步打开的：打开前先来一次调用，验证不会被丢掉。
  async function* s() { yield { type: "finish", reason: { kind: "stop" } }; }
  const result = await ctx.fireWaterfall("llm/stream", { model: "test" }, () => s());
  for await (const _ of result) { /* 吃掉 */ }
  await new Promise((r) => setTimeout(r, 20));
  const { json } = await call(ctx, "/ark-quota/stats", "GET", "/ark-quota/stats");
  assert(json.total === 101, "重启恢复：落盘 100 + 启动后 1 = 101");
  assert(json.succeeded === 99, "重启恢复：成功数累加（98 + 1）");
  assert(json.failed === 2, "重启恢复：失败数从落盘读回");
  assert(json.startedAt === prior.startedAt, "重启恢复：起始时间沿用更早的那个");
  // 落盘里的分钟桶也要回到健康条上
  const withSamples = json.dots.filter((d) => d.status !== "empty");
  assert(withSamples.length >= 2, "重启恢复：落盘的分钟桶回到健康条");
}

// --- 在途请求：total 与「近 30 分钟」口径必须一致 ---
{
  // 这是"请求总数 18 / 近 30 分钟 17"那个 bug 的守卫。
  const T0 = 1_700_000_000_000;
  const base = { startedAt: T0, total: 0, ok: 0, fail: 0, inflight: 0, buckets: [] };
  const started = foldStats(base, "start", T0);
  assert(started.inflight === 1, "foldStats: start 让在途数 +1");
  assert(started.total === 1 && started.buckets.length === 0, "foldStats: start 只加 total，不落桶");
  const midShape = shapeStats(started, T0 + 1000);
  assert(midShape.total === midShape.recent, "流式进行中：total 与近 30 分钟口径一致（差值为 0）");
  assert(midShape.inflight === 1, "shapeStats: 在途数透传给前端");
  // 结束后在途数归零，桶里才出现这次记录
  const finished = foldStats(started, "ok", T0 + 2000);
  assert(finished.inflight === 0, "foldStats: 结束让在途数 -1");
  const doneShape = shapeStats(finished, T0 + 3000);
  assert(doneShape.total === 1 && doneShape.recent === 1, "结束后 total 与近 30 分钟仍然相等");
  // 脏数据保护：没有 start 的结束不能把在途数压成负值
  const clamped = foldStats(finished, "ok", T0 + 4000);
  assert(clamped.inflight === 0, "foldStats: 在途数被 clamp 在 0，不会变负");
  assert(shapeStats(clamped, T0 + 5000).recent === 2, "clamp 后近 30 分钟不会被负数拉低");
  // 旧版落盘态没有 inflight 字段：读回时按 0 处理，不能变成 NaN
  const legacy = { startedAt: T0, total: 7, ok: 7, fail: 0, buckets: [] };
  assert(shapeStats(legacy, T0 + 1000).inflight === 0, "旧落盘态缺 inflight → 视为 0");
  assert(foldStats(legacy, "start", T0 + 1000).inflight === 1, "旧落盘态 fold 后在途数正常递增");
}

// --- 路由层：流未结束时 total 与 recent 也必须相等 ---
{
  const ctx = mockCtx();
  apply(ctx, { accessKeyId: "x", secretAccessKey: "y", region: "cn-beijing", version: "2024-01-01", refreshMs: 300000 });
  await new Promise((r) => setTimeout(r, 20));
  // 造一个"卡在中途"的流：第一个 chunk 之后挂住，模拟正在输出的回答。
  let release = null;
  const held = new Promise((r) => { release = r; });
  async function* slowStream() {
    yield { type: "content-delta" };
    await held;
    yield { type: "finish", reason: { kind: "stop" } };
  }
  const stream = await ctx.fireWaterfall("llm/stream", { model: "test" }, () => slowStream());
  const iter = stream[Symbol.asyncIterator]();
  await iter.next(); // 消费第一个 chunk：此刻请求已开始、尚未结束
  const mid = (await call(ctx, "/ark-quota/stats", "GET", "/ark-quota/stats")).json;
  assert(mid.total === 1, "路由：请求开始即计入总数");
  assert(mid.inflight === 1, "路由：在途数为 1");
  assert(mid.total === mid.recent, "路由：进行中时总数与近 30 分钟相等（不再差 1）");
  // 落盘快照里的在途数必须是 0：进程重启后那些请求不可能还在跑
  await new Promise((r) => setTimeout(r, 2100));
  const storedMid = ctx.__stored();
  assert(storedMid !== null && storedMid.inflight === 0, "落盘快照把在途数写成 0（不跨进程）");
  // 放行并读完，在途数归零、口径依旧一致
  release();
  await iter.next();
  await iter.next();
  const done = (await call(ctx, "/ark-quota/stats", "GET", "/ark-quota/stats")).json;
  assert(done.inflight === 0, "路由：流结束后在途数归零");
  assert(done.total === 1 && done.succeeded === 1, "路由：结束后计一次成功，总数不重复累加");
  assert(done.total === done.recent, "路由：结束后总数与近 30 分钟仍然相等");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-host: all passed");
