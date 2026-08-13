# 为 dsh-ark-quota 贡献代码

[English](./CONTRIBUTING.md) · **简体中文**

感谢你关注 `dsh-ark-quota`！本插件属于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）生态：其架构中**一切都是插件**（基于 [Cordis](https://github.com/cordiverse/cordis)）。DSH 官方目前不接受核心仓库的外部 PR，但**社区插件正是官方鼓励的扩展方式**——给插件仓库打上 `dsh-plugin` GitHub topic 就是生态互相发现的方式（本项目已打标）。

> ⚠️ DeepSeek Harness 仍处于 **developer preview** 阶段，迭代很快，**会有破坏性变更**。请固定你开发所依赖的 DSH 版本，升级后重新测试。

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `lib/index.js` | 宿主半区：注册 `ark-quota` 设置命名空间，并在同源路由 `/ark-quota` 上代理控制台接口（`ctx.webServer.register`）。 |
| `lib/client.js` | 浏览器半区：手工编写的客户端 bundle，使用加载器规定的格式（`window.__ModuleLoader__.load({ id, factory })`），通过 `ctx.slots.inject` / `ctx.slots.register` 注册 `sidebar.footer.action` 小组件。 |
| `tools/refresh.mjs` | 独立 Node CLI：弹出 Edge（CDP，仅回环），登录后提取会话 Cookie，原子写入 `$DSH_HOME/settings.yaml`。 |
| `cordis.patch.yml.example` | 带 `PASTE_*` 占位符的示例 profile 条目。 |

本仓库**没有构建步骤**：客户端 bundle 直接以 DSH 客户端模块加载器要求的格式编写，宿主半区为纯 ESM。保持无构建是刻意的设计——详见[开发流程](#开发流程)。

## 开发环境搭建

### 前置要求

- Node.js ≥ 22（依赖全局 `fetch`、`WebSocket`、`AbortSignal.timeout`）
- 一个 DeepSeek Harness Web profile（`dsh web`，默认端口 `127.0.0.1:3080`）
- `pnpm`（仅当你需要跑 DSH 的 dev watcher 时；插件本身无需安装步骤）

### 本地运行

最简单的迭代方式：把本仓库 clone（或 symlink）进 profile 的 workspace 并指向它：

```yaml
# $DSH_HOME/profiles/<profile>/pnpm-workspace.yaml
packages:
  - .
  - 'node_modules/dsh-ark-quota'   # 或指向你 checkout 的路径/symlink
```

然后在 `cordis.patch.yml` 中加入条目（参考 `cordis.patch.yml.example`），启动 `npx @deepseek-ai/dsh web`，打开 `http://127.0.0.1:3080`。

### 插件是如何加载的（改代码前必读）

- **Node 半区**（`@deepseek-ai/dsh-client-modules`）扫描启用的 Loader 条目中带 web `dsh.client` 的包，解析其 `exports["./client"]`，把 bundle 哈希进启动图并挂在 `/plugins` 下提供服务。**增删插件条目（改变插件集合）必须重启服务**——启动图在启动时构建。
- **客户端 bundle 是懒加载的**：执行脚本只注册 factory（`window.__ModuleLoader__.load`）；factory 体在物化时运行（`factory(require)` → 含 `apply` + `inject` 的 `module.exports`）。
- **宿主半区的改动一律需要重启服务**（宿主不热重载文件包；动态运行器只跑沙箱内联包）。
- **客户端 bundle 改动可热重载**（`@deepseek-ai/dsh-client-hmr`：浏览器轮询 `GET /plugins/events`，每个 `rebuilt` 帧重载一个插件）。但**只有重建 watcher 重写了 bundle 才会触发**——即需要从 DSH 源码 checkout 运行 `pnpm run dev:web` 并 watch 本包。没有 watcher 时，改完 `lib/client.js` 手动 F5 就是常规迭代方式。HMR 重载是粗粒度的：被重载插件内的 React 状态会丢失。

## 开发流程

### 修改宿主（`lib/index.js`）

1. 修改代码。
2. 验证配置 schema 仍能通过：`Config['~standard'].validate(config)`（schemastery 实现了 Standard Schema 接口）。
3. 用 mock `ctx`（`webServer`、`settings`、`effect`、`logger`）跑宿主冒烟测试（见[测试](#测试)）。
4. 重启 DSH，端到端验证 `GET /ark-quota`。

约定：

- 所有注册都通过 `ctx.effect(fn, label)` 包裹，保证 fiber 级的清理。
- 保留设置命名空间注册（`ctx.settings.register(ARK_QUOTA_NS, SettingsSchema, { base })`）——这是免重启维护的接缝；读取**生效配置**要用 scope（`scope.get()`），不要读静态 `config`。
- 任何设置变更都必须清空内存中的 csrf token 与缓存（在 `scope.watch` 回调里做）。
- 路由绝不能回显 Cookie，且只接受固定形状的输入（不接受用户可控 URL）。

### 修改客户端（`lib/client.js`）

该文件就是交付的 bundle——请按加载器规定格式编写：

```js
window.__ModuleLoader__.load({
  id: "dsh-ark-quota",
  factory: (require) => {
    // 只允许 require("react") / require("react/jsx-runtime")——bundle 纯净性
    // 检查禁止跨插件值导入；跨插件协作走 cordis 服务。
    function apply(ctx) { /* slots.inject / slots.register ... */ }
    return { apply, inject: ["slots", "settingsScope"] };
  }
});
```

约定：

- 用 `ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name, id, order, label, inject }, Component))` 注册组件——该 slot 由 shell 声明；`slots.inject` 会等待声明，因此激活顺序无关紧要。
- 用 `ctx.settingsScope.bind({ namespace: "ark-quota" })` 绑定设置命名空间，并通过注册项的 `inject` → `hooks` 面暴露给组件；设置 revision 变化时组件重新拉取。
- 一切渲染走 React 元素/属性（React 自动转义）；**禁止**对来自控制台的字符串使用 `dangerouslySetInnerHTML` 或 `innerHTML`。
- bundle 除 `react` / `react/jsx-runtime`（`react-dom` 仅测试用）外不依赖任何东西——手工复刻 bundle 纯净性检查。
- 改完重跑客户端渲染冒烟测试（`react-dom/server` SSR）。

### 修改 `tools/refresh.mjs`

它是独立 Node CLI（不依赖 DSH）。必须守住的安全不变量：

- CDP 端口**仅绑定 `127.0.0.1`**。
- **所有**退出路径都要清理：优雅 `Browser.close`、兜底 `taskkill /T /F`、删除临时浏览器目录、SIGINT/SIGTERM 处理器、try/finally。
- `settings.yaml` 必须原子写入（临时文件 + `rename`）。
- 绝不打印完整 Cookie 值——必须截断（`slice(0,12) + "…" + slice(-8)`）。
- Cookie 域名匹配用 `endsWith(".volcengine.com")`，不要用 `includes`。

## 安全要求（强制）

本插件处理的是**真实会话凭据**（火山方舟控制台 Cookie：`userInfo` / `digest` JWT、`csrfToken`）。请把它们当作密码对待。

1. **绝不提交真实 Cookie / token / 密钥**——任何文件、任何提交、任何分支都不行。文档与示例一律用 `PASTE_*` 占位符。
2. **绝不打印完整 Cookie 值**——插件、工具、调试输出都不行。
3. **绝不在 HTTP 响应中回显 Cookie**——代理响应必须只包含额度数据。
4. **`.gitignore` 是最后一道防线**：`settings.yaml`、`cordis.patch.yml`、`.dsh/`、`.env`、`.npmrc` 均被忽略。如果新增了可能存放凭据的文件，记得也忽略它。
5. **CDP 刷新工具**运行着一个持有你实时会话的浏览器：仅回环、短生命周期、每条退出路径都清理。不要把它改造成长期运行的服务。
6. 推送前跑一遍敏感信息扫描（可按需调整正则）：

   ```sh
   grep -rInE 'eyJhbGciOi|ark-[A-Za-z0-9]{20,}|gho_|ghp_|github_pat_|AKLT|Bearer [A-Za-z0-9._-]{20,}' .
   ```

   输出中**不允许出现真实值**（仅允许 `csrfToken` 之类的字段名引用和 `PASTE_*` 占位符）。

**发布前必须做一次 pro 模型安全审计**：打版本标签前，让强模型审查 diff——凭据泄漏、代理的 SSRF/请求头注入、组件 XSS、刷新工具的生命周期缺陷。

## 测试

本仓库没有测试框架——验证方式是纯 Node 可跑的脚本：

1. **语法**：`node --check lib/index.js lib/client.js tools/refresh.mjs`。
2. **宿主冒烟测试**（mock `ctx`，不起服务）：命名空间以 patch 配置为 base 注册；`scope.get()` 驱动生效配置；设置变更（watch 回调）后下一次请求携带新 Cookie；坏 Cookie 映射为 `401` + `ok:false`；HEAD 无响应体。
3. **客户端渲染冒烟测试**：在 `window.__ModuleLoader__` stub 中加载 bundle，用 mock 的 `slots`/`settingsScope` 调 `apply`，用 `react-dom/server` SSR 小组件（宽版 + 窄版）。
4. **端到端**：重启 DSH → `curl http://127.0.0.1:3080/ark-quota?force=1` 返回最新额度 → 侧边栏底部渲染出组件 → 跑一次 `tools/refresh.mjs` 确认无需重启组件即更新。

## 提交与 PR 规范

- **提交信息**：一次提交一个逻辑变更，使用常规前缀（`feat:`、`fix:`、`docs:`、`chore:`、`refactor:`），摘要行用祈使句；不显然时在正文解释*为什么*。
- **文档**：面向用户的功能变更需要**同步更新** `README.md` 与 `README.zh-CN.md`；贡献文档同样是双语的。
- **范围**：PR 保持小而聚焦。动过代理的 PR 必须附上冒烟测试证据。
- **向后兼容**：DSH 变化很快——请在 PR 描述里注明你测试所用的 DSH 版本。

## 发版流程

1. 在 `package.json` 中按 semver 提升 `version`。
2. 功能集有变化时更新 README。
3. 跑完[测试](#测试)全清单 + [安全要求](#安全要求强制)扫描 + 对 diff 做一次 pro 模型安全审计。
4. 提交，然后打标签并发版：

   ```sh
   git tag vX.Y.Z
   git push origin main --tags
   gh release create vX.Y.Z --generate-notes
   ```

## 参考文档

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 官方仓库；[CONTRIBUTING.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md) 说明了为什么社区插件是贡献渠道。
- `@deepseek-ai/dsh-client-modules` —— 启动图、`/plugins` 服务、懒加载 `__ModuleLoader__` factory 模型。
- `@deepseek-ai/dsh-client-hmr` —— `GET /plugins/events` 重载链路与 `pnpm run dev:web` watcher 要求。
- `@deepseek-ai/dsh-client-ui-slots` —— slot 注册契约（`register({ name, children?, store?, inject?, ...kind }, Component)`）。
- `@deepseek-ai/dsh-client-runtime` —— `ctx.slots.inject` 声明注入、`bindSettingsScope` / 设置命名空间。
- `@deepseek-ai/dsh-settings` / `dsh-settings-file` —— 宿主设置注册表，`register(ns, schema, { base })` → `{ get, watch, update }`，`settings.yaml` 热重载。
- [Cordis](https://github.com/cordiverse/cordis) —— 一切所依托的插件框架。

## 许可证

通过贡献，你同意你的贡献按本项目的 [MIT](./LICENSE) 许可证授权。
