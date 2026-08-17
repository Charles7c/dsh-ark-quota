#!/usr/bin/env node
// dsh-ark-quota AK/SK self-check.
//
// Signs the control-plane OpenAPI call (GetCodingPlanUsage, falling back to
// GetAFPUsage) and prints the subscription quota — or a friendly error. Use it
// to verify your Volcengine access keys before or after configuring the
// plugin. No browser, no cookies, nothing written to disk.
//
// Usage:
//   node tools/check.mjs <accessKeyId> <secretAccessKey>
//   ARK_AK=<ak> ARK_SK=<sk> node tools/check.mjs
import { buildSignedRequest } from "../lib/signature.js";

const ak = process.argv[2] ?? process.env.ARK_AK ?? "";
const sk = process.argv[3] ?? process.env.ARK_SK ?? "";

if (!ak || !sk) {
  console.error("用法: node tools/check.mjs <accessKeyId> <secretAccessKey>");
  console.error("或    ARK_AK=<ak> ARK_SK=<sk> node tools/check.mjs");
  console.error("（密钥仅用于本次签名验证，不写入任何文件）");
  process.exit(1);
}

const ACTIONS = ["GetCodingPlanUsage", "GetAFPUsage"];

async function call(action) {
  const { url, headers } = buildSignedRequest({
    accessKeyId: ak,
    secretAccessKey: sk,
    region: "cn-beijing",
    version: "2024-01-01",
    action,
  });
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: "",
    signal: AbortSignal.timeout(20000),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: resp.status, json };
}

const truncate = (s, n = 12) => (s.length > n ? s.slice(0, n) + "…" : s);
const authish = (code) => /auth|signature|accessdenied|denied|unauthorized|forbidden|credential|token|accesskey|invalid/i.test(String(code ?? ""));

async function main() {
  console.log("== 火山方舟额度 AK/SK 自检 ==");
  console.log(`凭据: ${truncate(ak)}（AccessKeyId 前缀）\n`);

  let saw = false;
  for (const action of ACTIONS) {
    const { status, json } = await call(action);
    const err = json?.ResponseMetadata?.Error;
    if (err) {
      if (authish(err.Code) || status === 401 || status === 403) {
        console.error(`✗ ${action} 鉴权失败 (HTTP ${status}) ${err.Code}: ${err.Message}`);
        console.error("  请检查 accessKeyId / secretAccessKey 是否正确（控制台 → 访问控制 → API 访问密钥）。");
        process.exitCode = 2;
        return;
      }
      console.warn(`- ${action} (HTTP ${status}) ${err.Code}: ${err.Message}`);
      continue;
    }

    const result = json?.Result ?? {};
    const quota = result.QuotaUsage ?? result.Usages ?? result.Details ?? [];
    if (Array.isArray(quota) && quota.length > 0) {
      console.log(`✓ ${action} 成功（Coding Plan）:`);
      for (const q of quota) console.log(`  ${q.Level}: 已用 ${q.Percent ?? 0}%`);
      console.log("  凭据有效。插件配置相同密钥后即可在侧边栏看到额度。");
      saw = true;
      process.exitCode = 0;
      break;
    }
    const afp = ["AFPFiveHour", "AFPWeekly", "AFPMonthly"].filter((k) => Number(result?.[k]?.Quota ?? 0) > 0);
    if (afp.length > 0) {
      console.log(`✓ ${action} 成功（Agent Plan）:`);
      for (const k of afp) {
        const used = Number(result[k].Used ?? 0);
        const total = Number(result[k].Quota ?? 0);
        console.log(`  ${k}: 已用 ${used}/${total} (${((used / total) * 100).toFixed(1)}%)`);
      }
      console.log("  凭据有效。");
      saw = true;
      process.exitCode = 0;
      break;
    }
    console.warn(`- ${action}: HTTP ${status} 但未解析到额度（可能未订阅）`);
  }

  if (!saw && process.exitCode !== 2) {
    console.warn("未检测到 Coding/Agent Plan 订阅。请确认账号已开通套餐。");
    process.exitCode = 0;
  }
}

main().catch((error) => {
  console.error("出错:", error?.message ?? error);
  process.exit(1);
});
