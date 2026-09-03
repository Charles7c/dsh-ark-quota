#!/usr/bin/env node
// Host-half smoke test: mock ctx + stub fetch, no listening server.
import { Readable } from "node:stream";
import { apply, normalizeRefreshMs, ALLOWED_REFRESH_MS } from "../lib/index.js";

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

function mockCtx() {
  const routes = new Map();
  return {
    logger: { info() {}, warn() {} },
    effect(fn) { fn(); },
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
    __routes: routes
  };
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

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-host: all passed");
