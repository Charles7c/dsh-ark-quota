#!/usr/bin/env node
// Client-half smoke test. react / react-dom / jsdom are test-only — install
// them into gitignored scratch-test/, never into package.json.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, "scratch-test");
const scratchReq = existsSync(join(scratch, "node_modules", "react"))
  ? createRequire(join(scratch, "package.json"))
  : null;

if (!scratchReq) {
  console.error("scratch-test/node_modules/react missing; install react, react-dom, jsdom there (gitignored).");
  process.exit(1);
}

const React = scratchReq("react");
const { JSDOM } = scratchReq("jsdom");

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const v = fn();
        if (v) return resolve(v);
      } catch {
        // keep waiting
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const now = Date.now();
const quotaJson = {
  ok: true,
  plan: "coding-plan",
  status: "Normal",
  updatedAt: Math.floor(now / 1000) - 600,
  cachedAt: now,
  refreshMs: 300000,
  hasReward: false,
  quota: [
    { level: "monthly", percentUsed: 40, percentRemaining: 60, cap: 100, rewardTotalPercent: 0, resetAt: Math.floor(now / 1000) + 3600, used: 40, total: 100 }
  ]
};

const statusJson = { ok: true, configured: true, accessKeyIdSet: true, secretAccessKeySet: true, refreshMs: 600000 };

// 请求统计桩：468 次请求、99.8% 成功、近 30 分钟 25 次。
// 健康条按业界 status strip 口径：每格 2 分钟，宿主直接给出 status 分档。
// 刻意造出三种档位，验证客户端不再自己按 fail>0 判定：
//   i=5  → 100 成功 / 1 失败 = 99.0% → 正常（旧实现会错标成红色）
//   i=11 →  19 成功 / 1 失败 = 95.0% → 降级
//   i=17 →   1 成功 / 1 失败 = 50.0% → 故障
const DOT_SPAN_MS = 2 * 60 * 1000;
function stubDot(i) {
  const startMs = now - (30 - i) * DOT_SPAN_MS;
  const shape = i === 5 ? { ok: 100, fail: 1, status: "ok" }
    : i === 11 ? { ok: 19, fail: 1, status: "degraded" }
    : i === 17 ? { ok: 1, fail: 1, status: "outage" }
    : i % 3 === 0 ? { ok: 2, fail: 0, status: "ok" }
    : { ok: 0, fail: 0, status: "empty" };
  const total = shape.ok + shape.fail;
  return {
    startMs,
    spanMs: DOT_SPAN_MS,
    ok: shape.ok,
    fail: shape.fail,
    rate: total > 0 ? shape.ok / total : null,
    status: shape.status
  };
}
const statsDots = Array.from({ length: 30 }, (_v, i) => stubDot(i));
const statsSampled = statsDots.filter((d) => d.status !== "empty").length;
const statsJson = {
  ok: true,
  persisted: true,
  startedAt: now - 42 * 60 * 1000,
  total: 468,
  succeeded: 467,
  failed: 1,
  rate: 467 / 468,
  recent: 25,
  recentMs: 30 * 60 * 1000,
  // 其中 2 个仍在流式输出：宿主把在途数一起算进 recent，口径才与 total 一致。
  inflight: 2,
  windowMs: 42 * 60 * 1000,
  windowRate: 0.97,
  windowSampledDots: statsSampled,
  dotSpanMs: DOT_SPAN_MS,
  dots: statsDots
};

async function main() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://127.0.0.1:3080/",
    pretendToBeVisual: true
  });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.MouseEvent = window.MouseEvent;
  const { createRoot } = scratchReq("react-dom/client");

  let factory;
  window.__ModuleLoader__ = {
    load({ factory: f }) { factory = f; }
  };
  const src = await readFile(join(root, "lib/client.js"), "utf8");
  const run = new Function("window", src);
  run(window);
  const mod = factory((id) => {
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return scratchReq("react/jsx-runtime");
    throw new Error("unexpected require: " + id);
  });

  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.startsWith("/ark-quota/status")) {
      return { json: async () => ({ ...statusJson }) };
    }
    if (u.startsWith("/ark-quota/credentials") && method === "POST") {
      return { json: async () => ({ ok: true, configured: true, refreshMs: 600000 }) };
    }
    if (u.startsWith("/ark-quota/settings") && method === "POST") {
      return { json: async () => ({ ok: true, configured: true, refreshMs: JSON.parse(opts.body).refreshMs }) };
    }
    if (u.startsWith("/ark-quota/stats")) {
      return { json: async () => ({ ...statsJson }) };
    }
    if (u.startsWith("/ark-quota")) {
      return { json: async () => ({ ...quotaJson }) };
    }
    throw new Error("unexpected fetch " + u);
  };
  globalThis.fetch = window.fetch;

  let Widget;
  let Settings;
  const ctx = {
    slots: {
      inject(_name, fn) { return fn(); },
      register(meta, Component) {
        if (meta.name === "sidebar.footer.action") Widget = Component;
        if (meta.name === "settings.section") Settings = Component;
        return () => {};
      }
    }
  };
  mod.apply(ctx);

  // Wide card: relative time must follow cachedAt (just now), not updatedAt (10 min ago).
  const mount = window.document.getElementById("root");
  const rootApi = createRoot(mount);
  rootApi.render(React.createElement(Widget, { wide: true }));
  await waitFor(() => mount.textContent.includes("刚刚更新"));
  assert(mount.textContent.includes("刚刚更新"), "footer uses cachedAt → 刚刚更新");
  assert(!mount.textContent.includes("10 分钟前更新"), "footer does not use stale updatedAt");
  // 刷新节奏不再占版面：完整文案挂在刷新按钮的 title 上。
  const refreshBtn = [...mount.querySelectorAll("button")].find((b) => /立即刷新/.test(b.getAttribute("title") || ""));
  assert(!!refreshBtn, "refresh button is present");
  assert(/每 5 分钟自动刷新/.test(refreshBtn.getAttribute("title")), "cadence lives on the refresh button title");
  assert(!/5 分钟/.test(mount.textContent), "cadence text no longer occupies the card body");
  // 显示模式胶囊常驻头部，明示当前看的是已用还是剩余。
  const pill = [...mount.querySelectorAll("button")].find((b) => /^(已用|剩余)$/.test(b.textContent.trim()));
  assert(!!pill, "display-mode pill is present in the header");
  assert(pill.textContent.trim() === "已用", "pill reflects the default used mode");
  // 更新时间靠右下角：它和奖励徽章之间有一个弹性占位。
  const footerSpacer = [...mount.querySelectorAll("span")].some((s) => /flex:\s*1/.test(s.getAttribute("style") || ""));
  assert(footerSpacer, "footer pushes the update time to the right");

  // 统计区：三列数字 + 健康条（数据来自 /ark-quota/stats）。
  await waitFor(() => mount.textContent.includes("请求总数"));
  assert(mount.textContent.includes("468"), "stats shows the total request count");
  assert(mount.textContent.includes("请求总数"), "stats labels the total column");
  assert(mount.textContent.includes("成功率"), "stats labels the success-rate column");
  assert(mount.textContent.includes("近 30 分钟"), "stats labels the recent-window column");
  assert(mount.textContent.includes("25"), "stats shows the recent count");
  // 口径说明挂在三列的 title 上：解释"总数为什么可能比已结束的多"。
  const colTip = (kw) => [...mount.querySelectorAll("div")]
    .map((d) => d.getAttribute("title") || "")
    .find((t) => t.includes(kw)) || "";
  assert(/请求发出即计数/.test(colTip("请求发出即计数")), "total column explains it counts at request start");
  assert(/已结束的请求数/.test(colTip("已结束的请求数")), "success-rate column excludes in-flight requests");
  const recentTip = colTip("近 30 分钟发起的请求数");
  assert(recentTip.length > 0, "recent column has a tooltip");
  assert(/其中 2 个仍在进行中/.test(recentTip), "recent tooltip discloses the in-flight count");
  // 467/468 = 99.8%，四舍五入到一位小数，不能显示成 100%
  assert(mount.textContent.includes("99.8%"), "success rate rounds to one decimal (99.8%)");
  assert(mount.textContent.includes("健康"), "health strip is labelled");
  // 窗口收窄到会话尺度（分钟级），不再是 4 小时
  assert(/最近 42 分钟/.test(mount.textContent), "health window shows the session-scale span (42 分钟)");
  assert(!/小时/.test(mount.textContent), "health window no longer spans hours");

  // 30 个格：每个是带 title 的 span，颜色由宿主给的 status 分档决定
  const dots = [...mount.querySelectorAll("span")].filter((s) => /→/.test(s.getAttribute("title") || ""));
  assert(dots.length === 30, "health strip renders 30 cells");
  const styleOf = (d) => d.getAttribute("style") || "";
  const isGreen = (s) => /#46a758|rgb\(70, 167, 88\)/i.test(s);
  const isOrangeDot = (s) => /#f5a524|rgb\(245, 165, 36\)/i.test(s);
  const isRed = (s) => /#e5484d|rgb\(229, 72, 77\)/i.test(s);
  const greenDots = dots.filter((d) => isGreen(styleOf(d)));
  const orangeDots = dots.filter((d) => isOrangeDot(styleOf(d)));
  const redDots = dots.filter((d) => isRed(styleOf(d)));
  assert(greenDots.length > 0, "operational cells render green");
  assert(orangeDots.length === 1, "the degraded cell (95%) renders orange");
  assert(redDots.length === 1, "the outage cell (50%) renders red");

  // 核心回归：100 成功 / 1 失败 = 99% 必须是绿色。
  // 旧实现按 fail>0 一律标红，把 99% 和 0% 画成同一个颜色。
  const highVolumeDot = dots.find((d) => /成功 100 · 失败 1/.test(d.getAttribute("title")));
  assert(!!highVolumeDot, "the 100/1 cell is present");
  assert(isGreen(styleOf(highVolumeDot)), "99% success stays green (not red on any failure)");
  assert(!isRed(styleOf(highVolumeDot)), "a single failure among 100 does not paint the cell red");

  // tooltip 以成功率为主角，不只是计数
  assert(/成功率 99%/.test(highVolumeDot.getAttribute("title")), "cell tooltip leads with the success rate");
  assert(/正常/.test(highVolumeDot.getAttribute("title")), "cell tooltip names the status band");
  assert(/故障/.test(redDots[0].getAttribute("title")), "outage cell tooltip names its band");
  assert(/成功率 50%/.test(redDots[0].getAttribute("title")), "outage cell tooltip carries its rate");
  // 空格明确标注为无请求，不能被误读成故障
  const emptyDot = dots.find((d) => /无请求/.test(d.getAttribute("title")));
  assert(!!emptyDot, "cells without samples are labelled 无请求");
  assert(!isRed(styleOf(emptyDot)) && !isGreen(styleOf(emptyDot)), "empty cells are neutral, not red or green");

  // 进度条：填充宽度 = 已用百分比，颜色按阈值切换（40% → 绿色系，同色系浅→深）。
  // jsdom 经 CSSOM 重新序列化 style，hex 会变成 rgb()，两种形式都接受。
  await waitFor(() => [...mount.querySelectorAll("div")].some((d) => /linear-gradient/.test(d.getAttribute("style") || "")));
  const styles = [...mount.querySelectorAll("div")].map((d) => d.getAttribute("style") || "");
  const fill = styles.find((s) => /linear-gradient/.test(s));
  assert(!!fill, "progress bar fill is present");
  // 40% 已用 → 填充宽 40%
  assert(/width:\s*40%/.test(fill), "fill width equals used percent (40%)");
  // 绿色系两个色标：#63c07c → #46a758
  assert(
    /(#63c07c|rgb\(99, 192, 124\))/i.test(fill) && /(#46a758|rgb\(70, 167, 88\))/i.test(fill),
    "low-usage fill stays in the green hue (no rainbow band)"
  );
  // 不能出现跨色系的黄/红色标（那是彩带写法的特征）。
  assert(!/(#f5c518|#e5484d|rgb\(245, 197, 24\)|rgb\(229, 72, 77\))/i.test(fill), "fill has no cross-hue stops");
  // 轨道底色：同色系淡色（40% → 绿色 18% 透明度），而不是灰底。
  const trackStyle = styles.find((s) => /rgba\(70, 167, 88, 0\.18\)/.test(s));
  assert(!!trackStyle, "track uses a translucent same-hue tint (green at 40%)");
  assert(!/--dsw-alias-track-bg/.test(trackStyle), "track no longer falls back to the grey theme token");

  // 阈值回归：62% 已用必须进入橙色档（50~80%），不能还是绿色。
  const quota62 = { ...quotaJson, quota: [{ ...quotaJson.quota[0], percentUsed: 62, percentRemaining: 38, used: 62 }] };
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.startsWith("/ark-quota/status")) return { json: async () => ({ ...statusJson }) };
    if (u.startsWith("/ark-quota/credentials") && method === "POST") {
      return { json: async () => ({ ok: true, configured: true, refreshMs: 600000 }) };
    }
    if (u.startsWith("/ark-quota/settings") && method === "POST") {
      return { json: async () => ({ ok: true, configured: true, refreshMs: JSON.parse(opts.body).refreshMs }) };
    }
    if (u.startsWith("/ark-quota/stats")) return { json: async () => ({ ...statsJson }) };
    if (u.startsWith("/ark-quota")) return { json: async () => ({ ...quota62 }) };
    throw new Error("unexpected fetch " + u);
  };
  globalThis.fetch = window.fetch;
  rootApi.render(React.createElement(Widget, { wide: true, key: "bar62" }));
  const isOrange = (s) => /#ffc95c|#f5a524|rgb\(255, 201, 92\)|rgb\(245, 165, 36\)/i.test(s);
  await waitFor(() => [...mount.querySelectorAll("div")].some((d) => isOrange(d.getAttribute("style") || "")));
  const fill62 = [...mount.querySelectorAll("div")].map((d) => d.getAttribute("style") || "").find((s) => /linear-gradient/.test(s));
  assert(isOrange(fill62), "62% used fills orange (50% threshold, not green)");
  assert(!/#63c07c|#46a758|rgb\(99, 192, 124\)|rgb\(70, 167, 88\)/i.test(fill62), "62% used shows no green stop");

  // Settings: save credentials must keep refreshMs on the select.
  rootApi.render(React.createElement(Settings, {}));
  await waitFor(() => mount.querySelector("select") && mount.querySelectorAll("select").length >= 2);
  const refreshSelect = [...mount.querySelectorAll("select")].find((s) => s.value === "600000");
  assert(!!refreshSelect, "status refreshMs=600000 is selected");
  const inputs = mount.querySelectorAll("input");
  const ak = inputs[0];
  const sk = inputs[1];
  function changeInput(el, value) {
    const tracker = el._valueTracker;
    if (tracker) tracker.setValue("");
    const setNative = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setNative.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  changeInput(ak, "test-ak-id");
  changeInput(sk, "test-sk");
  const saveBtn = [...mount.querySelectorAll("button")].find((b) => /保存访问密钥/.test(b.textContent));
  saveBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => mount.textContent.includes("已保存并热生效"));
  const refreshSelectAfter = [...mount.querySelectorAll("select")].find((s) => String(s.value) === "600000");
  assert(!!refreshSelectAfter, "credentials save keeps refreshMs selected (does not drop to undefined)");

  // 降级：旧宿主没有 /ark-quota/stats（404），统计区必须整段消失，卡片其余部分照常。
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.startsWith("/ark-quota/stats")) return { status: 404, json: async () => ({}) };
    if (u.startsWith("/ark-quota/status")) return { json: async () => ({ ...statusJson }) };
    if (u.startsWith("/ark-quota/credentials") && method === "POST") {
      return { json: async () => ({ ok: true, configured: true, refreshMs: 600000 }) };
    }
    if (u.startsWith("/ark-quota")) return { json: async () => ({ ...quotaJson }) };
    throw new Error("unexpected fetch " + u);
  };
  globalThis.fetch = window.fetch;
  rootApi.render(React.createElement(Widget, { wide: true, key: "no-stats" }));
  await waitFor(() => mount.textContent.includes("方舟额度"));
  await new Promise((r) => setTimeout(r, 60));
  assert(!mount.textContent.includes("请求总数"), "missing stats route hides the stats summary");
  assert(!mount.textContent.includes("健康"), "missing stats route hides the health strip");
  assert(mount.textContent.includes("方舟额度"), "quota card still renders without stats");

  rootApi.unmount();
  if (failed) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke-client: all passed");
}

await main();
