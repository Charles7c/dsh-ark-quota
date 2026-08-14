#!/usr/bin/env node
// dsh-ark-quota cookie refresh tool.
//
// Pops a real Edge window at the Volcano Ark subscription page. Log in there,
// and this tool extracts the session cookies from the browser via the CDP
// debugging protocol and writes them into $DSH_HOME/settings.yaml under the
// `ark-quota` namespace. dsh-settings-file hot-reloads that document, so the
// running plugin picks the new cookies up immediately — no restart, no YAML
// editing by hand.
//
// Security notes:
// - The CDP debugging port is bound to 127.0.0.1 only and lives for the login
//   window; while this tool is running, any OTHER local process could connect
//   to that port and read the session cookies of the popped browser. Close the
//   tool when done (Ctrl+C also tears everything down). Never run this on a
//   shared machine.
// - The throwaway browser profile is removed on every exit path (success,
//   error, Ctrl+C, crash). Cookies are written only to $DSH_HOME/settings.yaml
//   (outside this repo) and are never printed in full.
//
// Usage:  node tools/refresh.mjs
import { existsSync } from "node:fs";
import { readFile, writeFile, rm, rename, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import YAML from "yaml";

const EDGE_CANDIDATES = [
  // macOS
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  // Windows
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"
];
const SUBSCRIPTION_URL = "https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const WANTED_COOKIES = ["userInfo", "digest", "csrfToken"];

const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error("未找到 Edge/Chrome，无法弹出浏览器窗口。");
  process.exit(1);
}

const isArkDomain = (domain) => domain === "volcengine.com" || domain.endsWith(".volcengine.com");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function cdpSession(ws) {
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${msg.error.message}`));
      else resolve(msg);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
    }, 20000);
  });
  return send;
}

async function fetchJson(url) {
  const resp = await fetch(url);
  return resp.json();
}

const settingsPath = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "settings.yaml")
  : join(homedir(), ".dsh", "settings.yaml");

async function writeSettings(userInfo, digest, csrfToken) {
  let text = "";
  try { text = await readFile(settingsPath, "utf8"); } catch { /* absent */ }
  const doc = text.trim() === "" ? YAML.parseDocument("{}") : YAML.parseDocument(text, { prettyErrors: true });
  if (userInfo) doc.setIn(["ark-quota", "userInfo"], userInfo);
  if (digest) doc.setIn(["ark-quota", "digest"], digest);
  if (csrfToken) doc.setIn(["ark-quota", "csrfToken"], csrfToken);
  // Atomic replace: write to a sibling temp file, then rename over the target,
  // so a crash mid-write cannot leave a truncated settings.yaml behind.
  const tmp = settingsPath + ".tmp";
  await writeFile(tmp, doc.toString(), "utf8");
  await rename(tmp, settingsPath);
  console.log(`已写入 ${settingsPath}`);
}

async function verifyCookies(userInfo, digest, csrfToken) {
  // Server-side check against the real console API with the extracted cookies.
  const resp = await fetch("https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/GetCodingPlanUsage", {
    method: "POST",
    headers: {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      "x-web-id": "U2FsdGVkX1/5PNdS+cQxIt+7URSEcJ59ZjjT3gwhknNgNz6mZhgxNfJq59t4lEaP",
      "cookie": `userInfo=${userInfo}; digest=${digest}; csrfToken=${csrfToken}`,
      "Referer": "https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan"
    },
    body: "{}",
    signal: AbortSignal.timeout(20000)
  });
  const json = await resp.json();
  const meta = json?.ResponseMetadata ?? {};
  if (meta.Error) {
    if (meta.Error.Code === "InvalidCSRFToken") {
      // The console expected a different csrf token; use X-Need-Token if present.
      const need = resp.headers.get("x-need-token");
      if (need) return { ok: false, needToken: need };
    }
    return { ok: false, message: `${meta.Error.Code}: ${meta.Error.Message}` };
  }
  return { ok: true, result: json.Result };
}

async function main() {
  console.log("== 火山方舟 Cookie 刷新工具 ==");
  console.log(`1) 将弹出 Edge 窗口并打开方舟订阅页`);
  console.log(`2) 请在窗口中登录火山方舟（登录后额度页应正常显示）`);
  console.log(`3) 检测到登录后自动提取 cookie 并写入设置，窗口自动关闭\n`);

  const port = await freePort();
  let proc = null;
  let userDataDir = null;
  let pageWs = null;
  let ok = false;

  const teardown = async () => {
    // 1. Graceful browser close via the browser-level CDP endpoint.
    try {
      const ver = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      if (ver?.webSocketDebuggerUrl) {
        const bws = new WebSocket(ver.webSocketDebuggerUrl);
        await new Promise((res, rej) => { bws.addEventListener("open", res, { once: true }); bws.addEventListener("error", rej, { once: true }); });
        const bsend = cdpSession(bws);
        await bsend("Browser.close").catch(() => {});
        try { bws.close(); } catch { /* best effort */ }
      }
    } catch { /* no browser up yet */ }
    // 2. Force-kill the browser tree (idempotent; harmless if already closed).
    if (proc && proc.pid) {
      const isWin = process.platform === "win32";
      try {
        spawn(isWin ? "taskkill" : "pkill", isWin ? ["/PID", String(proc.pid), "/T", "/F"] : ["-P", String(proc.pid)], { stdio: "ignore" });
        if (!isWin) spawn("pkill", ["-f", "ark-quota-edge-"], { stdio: "ignore" });
      } catch { /* best effort */ }
    }
    // 3. Drop the throwaway profile holding the live cookies.
    if (userDataDir) {
      try { await rm(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    // 4. Close the page websocket.
    if (pageWs) { try { pageWs.close(); } catch { /* best effort */ } }
  };
  let tornDown = false;
  const teardownOnce = async () => { if (tornDown) return; tornDown = true; await teardown(); };
  process.on("SIGINT", () => { teardownOnce().finally(() => process.exit(130)); });
  process.on("SIGTERM", () => { teardownOnce().finally(() => process.exit(143)); });

  try {
    userDataDir = await mkdtemp(join(tmpdir(), "ark-quota-edge-"));
    proc = spawn(browser, [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=msEdgeFirstRunExperience",
      "--window-size=1200,850",
      "--window-position=120,80",
      SUBSCRIPTION_URL
    ], { stdio: "ignore", detached: false });

    // Wait for the CDP endpoint to come up.
    let targets = [];
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
        if (Array.isArray(targets) && targets.length > 0) break;
      } catch { /* not up yet */ }
      await sleep(500);
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      console.error("无法连接浏览器调试端口，请重试。");
      return;
    }
    const page = targets.find((t) => t.type === "page");
    if (!page) { console.error("未找到页面目标。"); return; }

    pageWs = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      pageWs.addEventListener("open", resolve, { once: true });
      pageWs.addEventListener("error", reject, { once: true });
    });
    const send = cdpSession(pageWs);
    await send("Network.enable");
    await send("Page.enable");

    // Wait for the user to log in: poll the full cookie jar (includes HttpOnly).
    console.log("等待登录中…（请在 Edge 窗口完成登录）");
    let cookies = [];
    const loginDeadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < loginDeadline) {
      try {
        const r = await send("Network.getAllCookies");
        const all = Array.isArray(r.result?.cookies) ? r.result.cookies : [];
        const jar = {};
        for (const c of all) {
          if (isArkDomain(c.domain) && WANTED_COOKIES.includes(c.name)) {
            jar[`${c.name}|${c.domain}`] = c.value;
          }
        }
        const has = (name) => Object.keys(jar).some((k) => k.startsWith(name + "|"));
        if (has("userInfo") && has("digest")) { cookies = all; break; }
      } catch { /* transient */ }
      await sleep(2000);
    }

    // Prefer the most specific domain value per name (console.volcengine.com > .volcengine.com).
    const pick = (name) => {
      const matches = cookies
        .filter((c) => c.name === name && isArkDomain(c.domain))
        .sort((a, b) => b.domain.length - a.domain.length);
      return matches.length > 0 ? matches[0].value : undefined;
    };
    const userInfo = pick("userInfo");
    const digest = pick("digest");
    let csrfToken = pick("csrfToken");

    if (!userInfo || !digest) {
      console.error("未检测到登录态（userInfo/digest cookie 缺失），请重试。");
      return;
    }

    // Rotate csrf if the console says the token is stale.
    let check = await verifyCookies(userInfo, digest, csrfToken || "");
    if (!check.ok && check.needToken) {
      csrfToken = check.needToken;
      check = await verifyCookies(userInfo, digest, csrfToken);
    }
    if (check.ok) {
      await writeSettings(userInfo, digest, csrfToken || "");
      console.log("Cookie 已更新：");
      console.log(`  userInfo  ${userInfo.slice(0, 12)}…${userInfo.slice(-8)}`);
      console.log(`  digest    ${digest.slice(0, 12)}…${digest.slice(-8)}`);
      console.log(`  csrfToken ${csrfToken ? csrfToken.slice(0, 4) + "…" + csrfToken.slice(-4) : "(空，代理将自动自举)"}`);
      const quota = check.result?.QuotaUsage ?? [];
      for (const q of quota) {
        console.log(`  ${q.Level}: 已用 ${q.Percent.toFixed(1)}%`);
      }
      console.log("\n设置已热生效（无需重启 DSH）。");
      ok = true;
    } else {
      console.error(`Cookie 校验失败: ${check.message || "未知错误"}`);
    }
  } finally {
    await teardownOnce();
  }

  // Exit gracefully: set the code and force-exit shortly after so lingering
  // handles cannot hang the process (avoids a libuv assertion on Windows).
  process.exitCode = ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 800);
}

main().catch((error) => {
  console.error("出错：", error);
  setTimeout(() => process.exit(1), 800);
});
