# dsh-ark-quota

[English](./README.md) · **简体中文**

**火山方舟（Volcano Ark）Coding Plan 订阅套餐剩余额度** —— DeepSeek Harness（DSH）Web 插件，在侧边栏底部以固定小组件实时展示你的套餐额度，无需离开 DSH 界面。

> 当前版本：`v0.2.0`（版本号见 [VERSION](./VERSION)）

- 宿主半区（`lib/index.js`）：由于 OpenAPI 网关不允许来自 DSH 源（127.0.0.1:3080）的跨域（CORS）请求，由宿主用你的火山引擎**访问密钥 AK/SK**（SigV4 变体签名）在同源路由 `/ark-quota` 上代理控制面 OpenAPI `GetCodingPlanUsage`（未订阅时自动回落到 Agent Plan 的 `GetAFPUsage`）。**无浏览器、无 Cookie、无 CSRF**。
- 浏览器半区（`lib/client.js`）：渲染额度卡片 / 窄条百分比胶囊，并在设置变更时自动刷新；同时在 **设置 → 方舟额度** 提供独立的顶级配置分区，可直接在 DSH 设置界面粘贴 AK/SK。
- `tools/check.mjs`：零依赖 CLI，用你的 AK/SK 签名一次请求并打印套餐额度——配置前后用它验证密钥是否正确。

> ⚠️ **安全提醒**：额度接口使用你的**火山方舟访问密钥（AccessKey ID + Secret）**鉴权，属于火山账号的真实凭据。请务必妥善保管：不要提交到任何仓库、不要粘贴到任何地方（只允许写入你自己的 `cordis.patch.yml` / `settings.yaml`，或 DSH 设置界面——那里以 `role('secret')` 标记、只写不回显）。

## 功能特性

- **侧边栏固定小组件**：侧边栏底部操作区显示宽版卡片（5小时 / 近1周 / 近1月三条用量进度，显示已用百分比），窄版显示百分比胶囊。**胶囊的颜色与数字都跟最紧急的一档走**（5 小时档告急时，收起侧栏也能看到红色警示），悬停可见三档明细。悬停任意一行可查看精确百分比、绝对用量（如有）与精确重置时刻。首屏加载有骨架条，卡片高度不跳动。
- **用量节奏**：周 / 月档的主角口径是「额度进度 vs 时间进度」——开周期以来的平均节奏（与 AWS Budgets / GCP Billing 同类告警同一口径），重置后立刻可用，也不会被某一天的重度使用带飞；5 小时档是滑动窗口，改用**水位动力学**（近期流入 − 窗口老化流出 = 净增速）判断会不会撞线。面板保持干净：每档只有「标签 · 近期速率 …… 百分比 · 重置倒计时」加一条进度条，状态靠颜色表达；鼠标悬停速率胶囊看 2~3 行精简明细（近期速度 vs 预算速度、时间/额度进度、预计用完或恢复时刻）。进度条灰色轨道上，**浅色预测段**标出按近期速度还要烧到的位置（段终点取近期速度与平均节奏投影较远者）。近期消耗速度由窗口内快照做**指数加权最小二乘回归**（越新的点权重越高，节奏突变时反应更快）。速率单位匹配决策尺度：5 小时档用 **%/小时**（预算 20%/时），周 / 月档用 **%/天**（预算 14.3%/天、3.3%/天，两档可直接对比）。快照通过 `ctx.storageDomain` 落盘，重启后观测历史不丢。
- **一键换号**：5 小时 / 周档预计 1 小时内用完（或已撞线）且配置了多个账号时，卡片头部直接出现红色「切到『某账号』」按钮——目标账号按近 1 月余量自动挑选。
- **多账号**：一组 AK/SK 只代表一个火山账号，因此插件维护的是账号列表。卡片头部右上角的下拉即可切换当前查看的账号（任意账号数量都稳定），切换结果会写回作为默认账号。显示名称支持中文。
- **路由归属与误配提醒**：每个账号可勾选属于它的 `llm` 提供方路由。设置界面默认只列出指向火山方舟端点（`volces.com` / `volcengine.com`）的路由；若已有路由被误勾到非火山端点（例如 `deepseek-official`），会明确点名提醒，可一键展开全部后取消。
- **Agent Plan 自动回落**：账号未订阅 Coding Plan 时，代理自动探测 `GetAFPUsage` 并渲染绝对额度窗口。
- **免重启维护**：密钥从 `ark-quota` 设置命名空间读取（`$DSH_HOME/settings.yaml`，由 `dsh-settings-file` 热重载）。任何变更立即清空缓存——**无需重启服务**。
- **设置界面配置**：DSH 设置 → **方舟额度** 顶级分区（与「侧边卡片」「配置同步」同级），可增删账号、改显示名（中文、回车即存）、勾选所属提供方，并一键保存 AK/SK（只写字段、热生效，且带防浏览器自动填充处理）。

## 环境要求

- DeepSeek Harness Web 运行时（`dsh web`），且组合了 `dsh-settings-file`（默认 Web profile 已包含）。
- 拥有火山引擎账号，已开通方舟 Coding Plan 套餐，并有可用的访问密钥（AK/SK）。

## 安装

1. 让本包从你的 profile 可被解析。加载器从 profile 目录解析 `name: dsh-ark-quota`，因此包必须**实体存在**于 `$DSH_HOME/profiles/<profile>/node_modules/dsh-ark-quota`（Node 常规的 `node_modules` 向上查找）。两种方式：

   - 直接把仓库克隆进模块路径：

     ```sh
     git clone https://github.com/lordqyxz/dsh-ark-quota \
       "$DSH_HOME/profiles/<profile>/node_modules/dsh-ark-quota"
     ```

   - 或将其作为 profile 的依赖安装，例如 `dsh plugin --profile <profile> add github:lordqyxz/dsh-ark-quota`（内部转发给 `pnpm add`）。

2. 将本包加入你 profile 的 workspace（`$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml`），让 pnpm 把已安装的副本视为 workspace 成员并链接其依赖：

   ```yaml
   packages:
     - .
     - 'node_modules/dsh-ark-quota'
   ```

   随后在 profile 目录运行 `pnpm install`。如果你的 harness 已提供 profile 的依赖（例如 `npx` 安装方式的 `$DSH_HOME/profiles/node_modules` 模块回退），`pnpm install` 可省略——本包的依赖（`@deepseek-ai/schemastery`、`zod`）已可直接解析，放好包即可。

3. 在 profile 的 `cordis.patch.yml` 中加入条目：

   ```yaml
   - insert:
       - id: ark-quota
         name: dsh-ark-quota
         config:
           accounts:
             - id: personal              # 需匹配 /^[a-z][a-z0-9_]*$/，内部标识；显示名用 label（可中文）
               label: 个人 Pro
               accessKeyId: ''           # 可留空——更推荐直接在 DSH 设置界面填写
               secretAccessKey: ''
               region: cn-beijing
               version: '2024-01-01'
               providers: [ark-coding-plan]
           activeAccountId: personal
           refreshMs: 300000
   ```

   旧的单账号写法（顶层 `accessKeyId` / `secretAccessKey`，没有 `accounts`）依然可用，
   会被自动迁移成一个 id 为 `default` 的账号。

4. 应用并验证。较新版本的 DSH 会通过 HMR 监听器热应用 `cordis.patch.yml` 的变更（宿主路由与客户端启动图无需重启即可重组）——用 `curl -i http://127.0.0.1:3080/ark-quota` 检查；若路由未生效，再重启 DSH 服务并刷新浏览器。侧边栏底部即出现小组件。

## 获取访问密钥

1. 打开火山引擎控制台 → **访问控制 → API 访问密钥**。
2. 创建一个访问密钥（AccessKey），记下 **AccessKey ID** 与 **Secret Access Key**。
3. 填入插件——最省事的方式是在 DSH 设置界面：**设置 → 方舟额度**（写入 `$DSH_HOME/settings.yaml`，热生效、**无需重启**）；也可以在 `cordis.patch.yml` 里配置 `accessKeyId` / `secretAccessKey`。

> 💡 **验证**：运行 `node tools/check.mjs <accessKeyId> <secretAccessKey>`（或 `ARK_AK=… ARK_SK=… node tools/check.mjs`），确认密钥能正确通过火山控制面 OpenAPI 签名并打印你的套餐额度——全程无浏览器。

## 使用

- 小组件按 `refreshMs`（默认 5 分钟，可在"设置 → 方舟额度"里改为 1/5/10/30 分钟或 1 小时）自适应轮询 `/ark-quota`，并在设置命名空间变更时立即刷新。只轮询当前查看的账号；其它账号按需加载（缓存新鲜时不请求上游）。
- 点击 **⟳** 按钮（或访问 `/ark-quota?force=1`）可强制立即刷新当前账号。
- 配置了 2 个及以上账号时，卡片头部右上角出现账号下拉。切换会换掉额度数据与节奏结论，并把选择写回作为默认账号。
- 每档只有一行进度条，状态全靠颜色表达；悬停速率胶囊看 2~3 行精简明细。周 / 月档的明细以「额度进度 ÷ 时间进度」为准（开周期以来的平均节奏，不需要快照历史，重置后立刻可用）；5 小时档是滑动窗口，按净增速（近期流入 − 老化流出）判断会不会撞线。近期速度由窗口内快照做指数加权最小二乘回归（5 小时档看近 30 分钟、周档看近 12 小时、月档看近 24 小时）；5 小时档悬停还能看到老化速率、净增速与预计恢复时刻。
- 密钥缺失或错误时显示错误卡片；在 **设置 → 方舟额度** 里修正（或重跑 `node tools/check.mjs`），组件会自动更新。

## 配置说明

所有配置存放在 `ark-quota` 设置命名空间。`cordis.patch.yml` 中的组合条目配置作为**基础层（base）**，`$DSH_HOME/settings.yaml` 中的用户层可覆盖它并热生效。

| 键                | 类型   | 默认值       | 说明                                        |
| ----------------- | ------ | ------------ | ------------------------------------------- |
| `accounts`        | array  | `[]`         | 火山账号列表（见下表）。为空时读取下面的旧版顶层字段，并迁移成一个 `default` 账号。 |
| `activeAccountId` | string | `""`         | 卡片默认显示哪个账号；指向不存在的账号时回落到第一个。 |
| `refreshMs`       | number | `300000`     | 代理缓存有效期；仅允许 `60000` / `300000` / `600000` / `1800000` / `3600000`。其它值会吸附到最近的白名单档位。 |
| `accessKeyId`     | string | `""`（secret）| **旧版**单账号 AccessKey ID，仅在 `accounts` 为空时读取。 |
| `secretAccessKey` | string | `""`（secret）| **旧版**单账号 Secret Access Key。            |
| `region`          | string | `cn-beijing` | 旧版默认地域。                                |
| `version`         | string | `2024-01-01` | 旧版默认控制面 OpenAPI 版本。                  |

`accounts` 中每一项：

| 键                | 类型     | 默认值       | 说明                                      |
| ----------------- | -------- | ------------ | ----------------------------------------- |
| `id`              | string   | —            | 内部稳定标识，需匹配 `/^[a-z][a-z0-9_]*$/`；同时作为该账号额度快照的落盘键。不合法或重复的 id 会被丢弃。 |
| `label`           | string   | 同 `id`      | 卡片与设置界面显示的名称，可任意填写（支持中文）。 |
| `accessKeyId`     | string   | `""`（secret）| 该账号的火山 AccessKey ID。                 |
| `secretAccessKey` | string   | `""`（secret）| 该账号的火山 Secret Access Key。            |
| `region`          | string   | `cn-beijing` | 方舟地域。                                  |
| `version`         | string   | `2024-01-01` | 控制面 OpenAPI 版本。                        |
| `providers`       | string[] | `[]`         | 属于本账号的 `llm` 提供方路由 id，用于在设置界面标识归属、并在勾到非火山端点时给出误配提醒。可留空（只看额度）。 |

> 关于 `providers`：它标记"哪条模型路由指向这个火山账号"。设置界面默认只列出 baseURL 指向火山方舟端点的路由，并对误勾到非火山路由（如 `deepseek-official`）给出警告；`?all=1` 可展开全部。显示名 `label` 可任意填写（支持中文），内部 `id` 只能小写字母/数字/下划线。

## API

`GET /ark-quota[?account=<id>][&force=1]` → 同源 JSON：

```json
{
  "ok": true,
  "plan": "coding-plan",
  "status": "Normal",
  "updatedAt": 1786639101,
  "cachedAt": 1786639101000,
  "refreshMs": 300000,
  "hasReward": false,
  "accountId": "personal",
  "accountLabel": "个人 Pro",
  "accounts": [{ "id": "personal", "label": "个人 Pro", "configured": true, "providers": ["ark-coding-plan"] }],
  "activeAccountId": "personal",
  "quota": [
    { "level": "monthly", "percentUsed": 90.18, "percentRemaining": 9.82, "cap": 100, "rewardTotalPercent": 0, "resetAt": 1786639101, "used": 90, "total": 100 }
  ]
}
```

`cachedAt` 为毫秒时间戳（该 payload 写入宿主缓存的时刻）。`updatedAt` / `resetAt` 仍为控制台 API 返回的 unix 秒。每个账号各自独立缓存。

失败时返回：`{ "ok": false, "code": "unauthorized" | "missing-auth" | "unknown-account" | "upstream" | "network", "message": "…", "accounts": [...] }`（HTTP 401 / 404 / 502 / 504）。失败响应也会带上账号列表，这样密钥失效时切换器不会消失。

`GET /ark-quota/providers` → `{ ok, providers: [{ id, name }], claimed: { <提供方 id>: <账号 id> }, foreignClaimed: [{ id, name, owner }], filtered, totalProviders }`——`llm` 服务已注册的路由，以及各自被哪个账号占用。默认只返回指向火山方舟端点的路由；`foreignClaimed` 列出已关联但**不是**火山端点的路由（误配提醒），`?all=1` 可列出全部。不含任何凭据。

`POST /ark-quota/accounts` → `{ action: "add" | "remove" | "update" | "activate", id, label?, providers? }`，返回与 `/ark-quota/status` 相同的载荷。密钥仍走 `/ark-quota/credentials`（新增可选的 `account` 字段），且从不回显。

> 额度响应里的 `burn` 字段（按账号、按周期）给出用量节奏。**周 / 月档主角是平均节奏**：`paceRatio`（额度进度 ÷ 时间进度，开周期以来的平均燃烧倍率）、`projectedAtReset`（按平均节奏外推到重置时的预计已用百分比，可能 >100）、`timeProgress` / `quotaProgress`（时间进度与额度进度）。**近期速率**：`perDay`（窗口内快照指数加权最小二乘斜率，%/天，半衰期 = 观测窗口 1/3）、`budgetPerDay`（匀速用完刚好到重置的预算速度）、`ratio`（近期倍率 = perDay ÷ budgetPerDay）、`trendRatio`（近期倍率 ÷ 平均倍率，>1 表示正在加速）、`exhaustAt`（预计耗尽时刻，毫秒；周 / 月档按近期速率线性外推，5 小时滑窗档按净增速外推）、`sampleMs` / `samples`（近期速率的观测跨度与样本数）。**5 小时滑窗档专有**：`agingPerDay`（窗口老化流出速率，取窗口前一段快照斜率，缺失时前端用预算速率做先验）、`netPerDay`（净增速 = 近期流入 − 老化）、`recoverAt`（已撞线时，停用后水位回落到 95% 的预计时刻，毫秒）；该档不做时间进度投影。`status`（`ok` / `warn` / `over`）：周 / 月档以平均节奏投影为准（≥100% 撞线、≥85% 余量紧张），5 小时档以近期倍率为准、净增速仍会撞线时至少 `warn`、1 小时内撞线升 `over`；上游未给重置时刻或周期刚起步时退回近期倍率口径。账号清单项另带 `monthlyPct`（该账号最近观测的近 1 月已用百分比，供换号建议）。

## 安全说明

- `/ark-quota`、`/ark-quota/status`、`/ark-quota/providers`、`/ark-quota/accounts`、`/ark-quota/credentials`、`/ark-quota/settings` 这些路由**仅限本机**（绑定在 DSH 服务上）且**无鉴权**：同一台机器上的任何进程都能读取你的额度数据、触发一次带鉴权的刷新、通过 `POST /ark-quota/credentials` 覆盖访问密钥、通过 `POST /ark-quota/accounts` 增删账号，或通过 `POST /ark-quota/settings` 修改轮询间隔（影响面等同本机可直接读写 `settings.yaml`）。三个会写配置的 POST 路由带有**同源校验**：浏览器发来的跨站表单 POST（你开着 DSH 时访问的其他网页也能向本地端口发请求）会按 `Sec-Fetch-Site` / `Origin` 头拦下（403），本机进程直连（curl 等）不受影响。但它们**绝不会回显你的访问密钥**（响应只含布尔状态 / 额度数字 / 账号 id 与标签）；`/ark-quota/credentials` 只接受固定形状的 `account` / `accessKeyId` / `secretAccessKey` 字段，`/ark-quota/accounts` 只接受固定的 action 加 id、标签与提供方 id 列表，`/ark-quota/settings` 只接受固定白名单中的 `refreshMs` 数值，都不接受任何用户可控的 URL，因此无法作为代理/SSRF 跳板或泄漏火山凭据。插件加载期间请勿将 DSH 服务暴露到非回环地址。
- 访问密钥是真实凭据，存放于 `$DSH_HOME` 下的 `cordis.patch.yml` / `settings.yaml`；在设置 schema 中以 `role('secret')` 声明（DSH 设置界面以只写字段展示、绝不把值回传浏览器），并**已被 git 排除**（见 `.gitignore`）。
- `tools/check.mjs` 只用命令行 / `ARK_AK` / `ARK_SK` 传入的密钥签名一次请求，**不写盘、不全量打印**。

## 参与贡献

欢迎贡献！参与方式、提交与 PR 规范、发版流程见 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)（English: [CONTRIBUTING.md](./CONTRIBUTING.md)）。AI agent 与深度开发者请先读 [AGENTS.md](./AGENTS.md)——它涵盖插件加载机制、编码约定、强制安全不变量与测试清单。

## 许可证

[MIT](./LICENSE)
