#!/usr/bin/env node
// Idempotent shell patch: give the 方舟额度 settings section a custom nav icon.
//
// Why this exists: DSH's settings nav icon is hardcoded in the
// dsh-client-ui-settings-general shell by *section id* — unknown ids fall back
// to the generic gear, and the slots runtime drops any registrant-supplied
// `icon` option (only key/id/order/label/priority ride through). There is no
// plugin hook, so the only way to brand the nav tab is a one-branch addition
// to that shell's navIcon(). Client bundles are served straight from disk
// (serveBundle does not validate rev), so the change applies on the next
// browser refresh — no DSH restart. Re-run after any DSH upgrade that resets
// node_modules; the backup makes --revert trivial.
//
// Usage: node tools/patch-settings-icon.mjs          # apply
//        node tools/patch-settings-icon.mjs --revert # restore original
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const target = join(dshHome, 'profiles/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js');
const backup = target + '.ark-orig';

const MARK = 'ark-quota-logo';

// The shell's navIcon() fallback (gear) — the ark-quota branch is inserted
// right before it. `react_jsx_runtime` / `SettingsRoot_module_css_default` are
// module-scope bindings of that bundle, so the inserted code can use them.
const ANCHOR = '\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline16, {';

// Official 火山方舟 (Volcano Ark) mark — same flattened paths as lib/client.js
// ArkLogo (blue #006AFF / cyan #00DCFF), embedded as inline SVG.
const BRANCH = `\t\t\t/* ${MARK} — 火山方舟 settings nav icon (applied by tools/patch-settings-icon.mjs) */
\t\t\tif (id === "ark-quota") return (0, react_jsx_runtime.jsxs)("svg", {
\t\t\t\tclassName: SettingsRoot_module_css_default.navIcon,
\t\t\t\twidth: 16,
\t\t\t\theight: 16,
\t\t\t\tviewBox: "0 0 24 24",
\t\t\t\tfill: "none",
\t\t\t\tshapeRendering: "geometricPrecision",
\t\t\t\tstyle: { flex: "none" },
\t\t\t\tchildren: [
\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", { d: "M0.347656 22.254H6.6917L3.81945 13.22C3.76717 13.05 3.58591 12.958 3.41859 13.0111C3.32099 13.043 3.2443 13.1208 3.21293 13.22L0.347656 22.254Z", fill: "#00DCFF" }),
\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", { d: "M15.7734 22.2655H23.1353L19.7576 11.6243C19.7053 11.4543 19.5241 11.3623 19.3568 11.4154C19.2592 11.4473 19.1825 11.5251 19.1511 11.6243L15.7734 22.2655Z", fill: "#00DCFF" }),
\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", { d: "M7.01172 22.2654H20.5922L14.1052 1.9564C14.0494 1.78648 13.8717 1.69444 13.7043 1.75108C13.6067 1.78294 13.5301 1.86082 13.4987 1.9564L7.01172 22.2654Z", fill: "#006AFF" }),
\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", { d: "M2.8863 22.2674H13.1657L8.32754 7.11265C8.27176 6.94273 8.09399 6.85069 7.92668 6.90733C7.82908 6.93919 7.75239 7.01707 7.72102 7.11265L2.88281 22.2674H2.8863Z", fill: "#006AFF" }),
\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", { d: "M5.73438 22.2673H14.4278L10.3844 9.67906C10.3286 9.50914 10.1508 9.4171 9.98349 9.47374C9.88589 9.5056 9.81269 9.58348 9.78132 9.67906L5.73786 22.2673H5.73438Z", fill: "#00DCFF" })
\t\t\t\t]
\t\t\t});
`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const revert = process.argv.includes('--revert');
if (revert) {
  if (!existsSync(backup)) fail(`no backup to restore: ${backup}`);
  writeFileSync(target, readFileSync(backup, 'utf8'));
  rmSync(backup);
  console.log('reverted to original:', target);
  process.exit(0);
}

if (!existsSync(target)) {
  fail(`settings shell bundle not found: ${target}\nDSH_HOME=${dshHome} — pass DSH_HOME or run on the DSH host`);
}

const src = readFileSync(target, 'utf8');
if (src.includes(MARK)) {
  console.log('already patched — nothing to do:', target);
  process.exit(0);
}
if (src.indexOf(ANCHOR) === -1 || src.indexOf(ANCHOR) !== src.lastIndexOf(ANCHOR)) {
  fail('navIcon gear fallback anchor missing or not unique — DSH bundle changed; update this script');
}
if (!existsSync(backup)) copyFileSync(target, backup);

const patched = src.slice(0, src.indexOf(ANCHOR)) + BRANCH + '\n' + src.slice(src.indexOf(ANCHOR));
writeFileSync(target, patched);

// Syntax gate (client bundles are plain CommonJS-ish script, so --check works).
execFileSync(process.execPath, ['--check', target]);
console.log('patched:', target);
console.log('backup:', backup);
console.log('next step: refresh the DSH browser tab — the 方舟额度 settings tab now shows the 火山方舟 mark.');
