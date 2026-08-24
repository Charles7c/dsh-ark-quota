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
const { createRoot } = scratchReq("react-dom/client");
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
  window.React = React;

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

  let pending = [];
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (pending.length) {
      const gate = pending.shift();
      await gate;
    }
    if (u.startsWith("/ark-quota/status")) {
      return { json: async () => ({ ...statusJson }) };
    }
    if (u.startsWith("/ark-quota/credentials") && method === "POST") {
      return { json: async () => ({ ok: true, configured: true, refreshMs: 600000 }) };
    }
    if (u.startsWith("/ark-quota/settings") && method === "POST") {
      return { json: async () => ({ ok: true, configured: true, refreshMs: JSON.parse(opts.body).refreshMs }) };
    }
    if (u.startsWith("/ark-quota")) {
      return { json: async () => ({ ...quotaJson }) };
    }
    throw new Error("unexpected fetch " + u);
  };

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
  assert(mount.textContent.includes("每 5 分钟自动刷新"), "cadence label from refreshMs");

  // Settings: save credentials must keep refreshMs on the select.
  rootApi.render(React.createElement(Settings, {}));
  await waitFor(() => mount.querySelector("select") && mount.querySelectorAll("select").length >= 2);
  const refreshSelect = [...mount.querySelectorAll("select")].find((s) => s.value === "600000");
  assert(!!refreshSelect, "status refreshMs=600000 is selected");
  const inputs = mount.querySelectorAll("input");
  const ak = inputs[0];
  const sk = inputs[1];
  const setNative = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setNative.call(ak, "test-ak-id");
  ak.dispatchEvent(new window.Event("input", { bubbles: true }));
  setNative.call(sk, "test-sk");
  sk.dispatchEvent(new window.Event("input", { bubbles: true }));
  const saveBtn = [...mount.querySelectorAll("button")].find((b) => /保存访问密钥/.test(b.textContent));
  saveBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await waitFor(() => mount.textContent.includes("已保存并热生效"));
  const refreshSelectAfter = [...mount.querySelectorAll("select")].find((s) => String(s.value) === "600000");
  assert(!!refreshSelectAfter, "credentials save keeps refreshMs selected (does not drop to undefined)");

  rootApi.unmount();
  if (failed) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke-client: all passed");
}

await main();
