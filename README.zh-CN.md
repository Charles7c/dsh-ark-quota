# dsh-ark-quota

[English](./README.md) · **简体中文**

**火山方舟（Volcano Ark）Coding Plan 订阅套餐剩余额度** —— DeepSeek Harness（DSH）Web 插件，在侧边栏底部以固定小组件实时展示你的套餐额度，无需离开 DSH 界面。

- 宿主半区（`lib/index.js`）：由于控制台 API 不允许来自 DSH 源（127.0.0.1:3080）的跨域（CORS）请求，由宿主在同源路由 `/ark-quota` 上代理控制台 `GetCodingPlanUsage` 接口。
- 浏览器半区（`lib/client.js`）：渲染额度卡片 / 窄条百分比胶囊，并在 Cookie 变更时自动刷新。
- `tools/refresh.mjs`：弹出真实浏览器窗口，你只需登录一次，工具自动提取会话 Cookie 写入 `$DSH_HOME/settings.yaml`——**热生效，无需重启**。

> ⚠️ **安全提醒**：额度接口使用你的**火山方舟控制台 Cookie**（JWT 会话凭据）鉴权，属于火山账号的高度敏感凭据。请务必妥善保管：不要提交到任何仓库、不要粘贴到任何地方（只允许写入你自己的 `cordis.patch.yml` / `settings.yaml`）。

## 功能特性

- **侧边栏固定小组件**：侧边栏底部操作区显示宽版卡片（会话 / 本周 / 本月三条用量进度），窄版显示本月剩余百分比胶囊。
- **CSRF Token 自动轮换**：控制台返回 `InvalidCSRFToken` 时，代理自动读取响应头 `X-Need-Token` 中的新 token 并重试一次。
- **免重启维护**：Cookie 从 `ark-quota` 设置命名空间读取（`$DSH_HOME/settings.yaml`，由 `dsh-settings-file` 热重载）。任何变更立即清空缓存——**无需重启服务**。
- **一键刷新 Cookie**：`tools/refresh.mjs` 弹出 Edge 浏览器，你登录后自动提取并写入 Cookie。

## 环境要求

- DeepSeek Harness Web 运行时（`dsh web`），且组合了 `dsh-settings-file`（默认 Web profile 已包含）。
- 已开通火山方舟 Coding Plan 套餐，并在 `console.volcengine.com` 保持登录态。

## 安装

1. 将本包加入你 profile 的 workspace（`$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml`），例如通过 git 依赖：

   ```yaml
   packages:
     - .
     - 'node_modules/dsh-ark-quota'
   ```

2. 在 profile 的 `cordis.patch.yml` 中加入条目：

   ```yaml
   - insert:
       - id: ark-quota
         name: dsh-ark-quota
         config:
           userInfo: 'PASTE_USERINFO_COOKIE'
           digest: 'PASTE_DIGEST_COOKIE'
           csrfToken: ''        # 可选；失效时代理会自动自举
           region: cn-beijing
           version: '2024-01-01'
           refreshMs: 300000
   ```

3. 重启 DSH 服务并刷新浏览器，侧边栏底部即出现小组件。

## 获取 Cookie

在**已登录**的浏览器中打开 `https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan`，按 F12 → Application（应用）→ Cookies → `console.volcengine.com`，复制以下值：

- `userInfo`
- `digest`
- `csrfToken`（可选）

严格必需的是 `userInfo` + `digest`；`csrfToken` 缺失或过期时，代理会在首次请求时自动恢复。

> 💡 **更省事的方式**：直接运行 `node tools/refresh.mjs`——它会弹出 Edge 并打开订阅页，你登录后自动提取并写入全部 Cookie 到 `$DSH_HOME/settings.yaml`（无需复制粘贴、无需重启）。

## 使用

- 小组件按 `refreshMs`（默认 5 分钟）轮询 `/ark-quota`，并在设置命名空间变更时立即刷新。
- 点击 **⟳** 按钮（或访问 `/ark-quota?force=1`）可强制立即刷新。
- 登录态过期时显示错误卡片；运行 `node tools/refresh.mjs` 重新登录即可，组件会自动更新。

## 配置说明

所有配置存放在 `ark-quota` 设置命名空间。`cordis.patch.yml` 中的组合条目配置作为**基础层（base）**，`$DSH_HOME/settings.yaml` 中的用户层可覆盖它并热生效。

| 键         | 类型   | 默认值       | 说明                                        |
| ---------- | ------ | ------------ | ------------------------------------------- |
| `userInfo` | string | *(必填)*     | 控制台 `userInfo` Cookie（JWT）             |
| `digest`   | string | *(必填)*     | 控制台 `digest` Cookie（JWT）               |
| `csrfToken`| string | `""`         | 控制台 `csrfToken` Cookie（自动轮换）       |
| `xWebId`   | string | *(内置)*     | 固定的 `x-web-id` 请求头                    |
| `region`   | string | `cn-beijing` | 方舟地域                                    |
| `version`  | string | `2024-01-01` | 控制台 API 版本                             |
| `refreshMs`| number | `300000`     | 代理缓存有效期，超时后重新拉取              |

## API

`GET /ark-quota` → 同源 JSON：

```json
{
  "ok": true,
  "status": "Normal",
  "updatedAt": 1786639101,
  "hasReward": false,
  "quota": [
    { "level": "monthly", "percentUsed": 90.18, "percentRemaining": 9.82, "cap": 100, "rewardTotalPercent": 0, "resetAt": 1786639101 }
  ]
}
```

失败时返回：`{ "ok": false, "code": "unauthorized" | "upstream" | "network", "message": "…" }`（HTTP 状态码分别为 401 / 502 / 504）。

## 安全说明

- `/ark-quota` 路由**仅限本机**（绑定在 DSH 服务上）且**无鉴权**：同一台机器上的任何进程都能读取你的额度数据或触发一次带鉴权的刷新。但它**绝不会回显你的 Cookie**（响应只包含额度数字），也不接受任何用户可控的 URL，因此无法作为代理/SSRF 跳板或泄漏火山凭据。插件加载期间请勿将 DSH 服务暴露到非回环地址。
- Cookie 是 JWT 会话凭据，存放于 `$DSH_HOME` 下的 `cordis.patch.yml` / `settings.yaml`，**已被 git 排除**（见 `.gitignore`）。
- `tools/refresh.mjs` 将 CDP 调试端口**仅绑定 127.0.0.1**，并使用操作系统临时目录下的临时浏览器配置，所有退出路径（成功 / 报错 / Ctrl+C）都会清理。**工具运行期间**（即你登录的过程中），本机其他进程可能连上该端口读取弹出浏览器中的会话 Cookie——请登录完让它自动结束即可；不要在共享机器上长时间挂起。

## 许可证

[MIT](./LICENSE)
