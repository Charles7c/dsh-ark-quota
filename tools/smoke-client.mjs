#!/usr/bin/env node
// Client-half smoke test. react / react-dom / jsdom are test-only — install
// them into the gitignored scratch-test/ dir, never into package.json:
//   mkdir -p scratch-test && cd scratch-test && npm i react react-dom jsdom
// Run from the repo root:  node tools/smoke-client.mjs
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, "scratch-test");
const scratchReq = existsSync(join(scratch, "node_modules", "react"))
  ? createRequire(join(scratch, "package.json"))
  : null;
if (!scratchReq) {
  console.error("scratch-test/node_modules/react 缺失；请在 scratch-test/ 里安装 react / react-dom / jsdom（该目录已被 gitignore）。");
  process.exit(1);
}

const React = scratchReq("react");
const { createRoot } = scratchReq("react-dom/client");
const { JSDOM } = scratchReq("jsdom");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed += 1; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── jsdom 环境 ───────────────────────────────────────────────
const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://127.0.0.1:3080/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// ── mock fetch ───────────────────────────────────────────────
const calls = [];
const nowSec = Math.floor(Date.now() / 1000);
const accounts = [
  { id: "company", label: "公司号", configured: true, providers: ["ark-coding-plan-company"] },
  { id: "personal", label: "个人号", configured: true, providers: ["ark-coding-plan"] }
];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  calls.push(u);
  let body = { ok: false };
  if (u.startsWith("/ark-quota/stats")) {
    body = { ok: false, code: "should-not-be-called" };
  } else if (u.startsWith("/ark-quota/status")) {
    body = { ok: true, configured: true, refreshMs: 300000, activeAccountId: "personal", accounts };
  } else if (u.startsWith("/ark-quota/providers")) {
    body = {
      ok: true,
      providers: [
        { id: "ark-coding-plan", name: "火山Coding Plan" },
        { id: "ark-coding-plan-company", name: "火山Agent Plan" }
      ],
      claimed: { "ark-coding-plan-company": "company", "ark-coding-plan": "personal", "deepseek-official": "company" },
      foreignClaimed: [{ id: "deepseek-official", name: "DeepSeek", owner: "company" }],
      filtered: 1
    };
  } else if (u.startsWith("/ark-quota/accounts")) {
    body = { ok: true, accounts, activeAccountId: "personal", configured: true, refreshMs: 300000 };
  } else if (u.startsWith("/ark-quota")) {
    body = {
      ok: true, plan: "coding-plan", refreshMs: 300000, cachedAt: Date.now(),
      accountId: "personal", accounts, hasReward: true,
      quota: [
        // 99.9% 用例：绝不能显示成 100%
        { level: "session", percentUsed: 99.9, percentRemaining: 0.1, resetAt: nowSec + 2 * 3600, used: null, total: null },
        // 周档：撞线投影（>100%）→ 应出现「用完」结论
        { level: "weekly", percentUsed: 80, percentRemaining: 20, resetAt: nowSec + 3 * 86400, used: null, total: null },
        // 月档：安全投影
        { level: "monthly", percentUsed: 23, percentRemaining: 77, resetAt: nowSec + 20 * 86400, used: null, total: null }
      ],
      burn: {
        monthly: {
          // 平均节奏投影（主角）：额度进度 23% ÷ 时间进度 33% = 0.7× → 投影 69%，正常
          perDay: 3.2, budgetPerDay: 3.33, ratio: 0.96, paceRatio: 0.7, trendRatio: 1.37, status: "ok",
          exhaustAt: Date.now() + 20 * 86400000,
          projectedAtReset: 69, timeProgress: 0.33, quotaProgress: 0.23, sampleMs: 86400000, samples: 14
        },
        weekly: {
          // 平均节奏投影 140% → 撞线；短期档给预计用完时刻
          perDay: 40, budgetPerDay: 14.3, ratio: 2.8, paceRatio: 1.4, trendRatio: 2.0, status: "over",
          exhaustAt: Date.now() + 12 * 3600000,
          projectedAtReset: 140, timeProgress: 0.57, quotaProgress: 0.8, sampleMs: 12 * 3600000, samples: 8
        }
      }
    };
  }
  return { json: async () => body, status: 200, ok: true };
};

// ── 加载 bundle ──────────────────────────────────────────────
let captured = null;
dom.window.__ModuleLoader__ = { load: (reg) => { captured = reg; } };
const source = readFileSync(join(root, "lib", "client.js"), "utf8");
(0, eval)(source);
if (!captured) { console.error("bundle 没有注册工厂"); process.exit(1); }
const mod = captured.factory((id) => {
  if (id === "react") return React;
  if (id === "react/jsx-runtime") return scratchReq("react/jsx-runtime");
  throw new Error("unexpected require: " + id);
});

// ── 捕获 slot 注册 ───────────────────────────────────────────
const slots = new Map();
mod.apply({
  slots: {
    inject: (name, cb) => { slots.set(name, cb()); },
    register: (desc, Component) => ({ desc, Component })
  }
});
const widgetReg = [...slots.values()].find((r) => r.desc.id === "ark-quota" && r.desc.name === "sidebar.footer.action");
const settingsReg = [...slots.values()].find((r) => r.desc.id === "ark-quota" && r.desc.name === "settings.section");
if (!widgetReg || !settingsReg) { console.error("slot 注册缺失：", [...slots.keys()]); process.exit(1); }

// ── 挂载 ─────────────────────────────────────────────────────
const rootEl = document.getElementById("root");
const root2 = createRoot(rootEl);
root2.render(React.createElement(
  "div", null,
  React.createElement("div", { id: "wide" }, React.createElement(widgetReg.Component, { wide: true })),
  React.createElement("div", { id: "rail" }, React.createElement(widgetReg.Component, { wide: false })),
  React.createElement("div", { id: "settings" }, React.createElement(settingsReg.Component, {}))
));

await wait(500);

const wideEl = document.getElementById("wide");
const wide = wideEl.textContent;
const rail = document.getElementById("rail").textContent;
const settings = document.getElementById("settings").textContent;

// 宽卡：核心内容
assert(wide.includes("方舟额度"), "宽卡渲染标题");
assert(wide.includes("5小时") && wide.includes("近1周") && wide.includes("近1月"), "宽卡渲染三档额度");
assert(wide.includes("Coding Plan"), "底部信息行有套餐徽章");
assert(wide.includes("含奖励额度"), "hasReward 时显示含奖励额度");
assert(wide.includes("分钟前更新") || wide.includes("刚刚更新"), "显示更新时间");

// 99.9% 不得显示成 100%
assert(!wide.includes("100%"), "99.9% 没有被四舍五入成 100%");
assert(wide.includes("99.9%"), "99.9% 保留一位小数显示");

// 结论行已下线：状态靠进度条与速率颜色表达，细节全在悬停提示（title）里
assert(!wide.includes("节奏正常") && !wide.includes("余量偏紧"), "行内不再渲染结论文字");
assert(wideEl.innerHTML.includes("用完"), "用完时刻细节在悬停提示里");
assert(wideEl.innerHTML.includes("比重置早"), "「比重置早…」细节在悬停提示里");
assert(wideEl.innerHTML.includes("时间 ") && wideEl.innerHTML.includes("额度 "), "时间/额度进度细节在悬停提示里");
// 速率胶囊在行内
assert(wide.includes("%/天"), "行内显示速率胶囊（%/天）");

// 账号切换器：头部 <select>，多账号
const selects = wideEl.querySelectorAll("select");
assert(selects.length >= 1, "头部渲染账号下拉 <select>");
const opts = [...(selects[0]?.querySelectorAll("option") || [])].map((o) => o.textContent);
assert(opts.some((t) => t.includes("公司号")) && opts.some((t) => t.includes("个人号")), "下拉含两个账号选项");

// 已移除的 stats / 显示模式
assert(!wide.includes("请求总数"), "不再显示请求总数");
assert(!wide.includes("成功率"), "不再显示成功率");
assert(!wide.includes("健康"), "不再显示健康条");
assert(!/已用|剩余/.test(wide.replace(/已用百分比|近1月已用/g, "")), "头部没有已用/剩余切换胶囊");
assert(!wide.includes("个提供方"), "底部不再显示 N 个提供方");

// rail 药丸：近1月已用百分比
assert(/\d+%/.test(rail), "rail 药丸显示百分比");
assert(!rail.includes("100%"), "rail 药丸不出现 100%");

// 设置页
assert(settings.includes("AccessKey"), "设置页有 AK/SK 输入");
assert(settings.includes("刷新频率"), "设置页有刷新频率");
assert(settings.includes("deepseek-official"), "设置页显示误关联警告");
assert(!settings.includes("显示方式"), "设置页没有已移除的显示方式项");
// 防自动填充诱饵
assert(!!document.querySelector('input[name="ark-decoy-username"]'), "存在防填充诱饵用户名框");
assert(!!document.querySelector('input[name="ark-decoy-password"]'), "存在防填充诱饵密码框");

// 网络：从未请求 /ark-quota/stats
const statsCalls = calls.filter((u) => u.startsWith("/ark-quota/stats"));
assert(statsCalls.length === 0, "客户端不再请求 /ark-quota/stats（实际 " + statsCalls.length + " 次）");

// rail 药丸不再是死按钮：aria-label 说明点击行为，点击不抛错
const railBtn = document.getElementById("rail").querySelector("button");
assert(!!railBtn, "rail 药丸渲染为 button");
assert((railBtn.getAttribute("aria-label") || "").includes("展开侧边栏"), "正常态 rail 按钮 aria-label 提示展开侧边栏");
railBtn.click();
assert(true, "点击 rail 药丸不抛错（无宿主按钮时静默降级）");

// 标签页切回前台 → 补一次拉取（后台定时器会被浏览器节流）
{
  // jsdom 默认 visibilityState 为 "hidden"，这里模拟浏览器里前台标签页的状态。
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  const before = calls.filter((u) => u.startsWith("/ark-quota?") || u === "/ark-quota").length;
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await wait(200);
  const after = calls.filter((u) => u.startsWith("/ark-quota?") || u === "/ark-quota").length;
  assert(after > before, "visibilitychange 回到前台触发一次额度拉取（" + before + " → " + after + "）");
}

// noPlan：两个套餐都无额度 → 明确提示未订阅，而不是含糊的「暂无额度数据」
{
  const standardFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("/ark-quota/status")) {
      return { json: async () => ({ ok: true, configured: true, refreshMs: 300000, activeAccountId: "personal", accounts }), status: 200 };
    }
    if (u.startsWith("/ark-quota/providers")) {
      return { json: async () => ({ ok: true, providers: [], claimed: {}, foreignClaimed: [], filtered: 0 }), status: 200 };
    }
    // 额度接口：成功但空 quota + noPlan
    return {
      json: async () => ({ ok: true, plan: "coding-plan", refreshMs: 300000, cachedAt: Date.now(), accountId: "personal", accounts, quota: [], noPlan: true, burn: {} }),
      status: 200
    };
  };
  const np = document.createElement("div");
  document.body.appendChild(np);
  const npRoot = createRoot(np);
  npRoot.render(React.createElement(widgetReg.Component, { wide: true }));
  await wait(300);
  assert(np.textContent.includes("未检测到方舟套餐订阅"), "noPlan 时提示未检测到套餐订阅");
  assert(np.textContent.includes("检查账号设置"), "noPlan 空态给出检查设置的入口");
  assert(!np.textContent.includes("暂无额度数据（"), "noPlan 时不再显示通用的「暂无额度数据」");

  // 出错态 rail 药丸：点击行为指向设置
  const errRail = document.createElement("div");
  document.body.appendChild(errRail);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("/ark-quota") && !u.includes("/status") && !u.includes("/providers")) {
      return { json: async () => ({ ok: false, code: "unauthorized", message: "访问密钥校验失败", accounts }), status: 401 };
    }
    return { json: async () => ({ ok: true, configured: false, refreshMs: 300000, accounts, activeAccountId: "personal", providers: [], claimed: {}, foreignClaimed: [], filtered: 0 }), status: 200 };
  };
  const errRoot = createRoot(errRail);
  errRoot.render(React.createElement(widgetReg.Component, { wide: false }));
  await wait(300);
  const errBtn = errRail.querySelector("button");
  assert(!!errBtn && errBtn.textContent === "!", "出错态 rail 药丸显示 !");
  assert((errBtn.getAttribute("aria-label") || "").includes("打开设置"), "出错态 rail 按钮 aria-label 提示打开设置");
  let clickThrew = false;
  try { errBtn.click(); } catch (e) { clickThrew = true; }
  assert(clickThrew === false && errRail.querySelector("button") === errBtn, "出错态点击不抛错、组件不崩");
  globalThis.fetch = standardFetch;
}

console.log("\nfetch 调用：", [...new Set(calls)].join(", "));
// React 的轮询 setTimeout / useNow setInterval 会让事件循环不空，必须显式退出。
process.exit(failed > 0 ? 1 : 0);
