# 为 dsh-ark-quota 贡献代码

[English](./CONTRIBUTING.md) · **简体中文**

感谢你关注 `dsh-ark-quota`！本插件属于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）生态：其架构中**一切都是插件**（基于 [Cordis](https://github.com/cordiverse/cordis)）。DSH 官方目前不接受核心仓库的外部 PR，但**社区插件正是官方鼓励的扩展方式**——给插件仓库打上 `dsh-plugin` GitHub topic 就是生态互相发现的方式（本项目已打标）。

> ⚠️ DeepSeek Harness 仍处于 **developer preview** 阶段，迭代很快，**会有破坏性变更**。请固定你开发所依赖的 DSH 版本，升级后重新测试。

## 参与方式

- **报告 bug / 提需求** —— 在 [GitHub Issues](https://github.com/lordqyxz/dsh-ark-quota/issues) 中说明：DSH 版本、Node 版本、操作系统、你使用的插件配置（Cookie 用占位符！）、预期行为与实际行为。疑问与想法请走 GitHub Discussions。
- **改进文档** —— README 与 CONTRIBUTING 均为中英双语维护；面向用户的功能变更需同步更新两个版本。
- **写代码** —— 见下方[开发](#开发)。代码 PR 必须附测试证据（见测试清单）。

## 开发

- **快速开始**：clone 本仓库，让 DSH profile 的 workspace 指向它，在 `cordis.patch.yml` 中加入条目（参考 `cordis.patch.yml.example`），运行 `npx @deepseek-ai/dsh web`。
- **完整技术工作流** —— 仓库结构、插件加载机制（重启 vs HMR 规则）、编码约定、强制安全不变量、测试清单——都在 **[AGENTS.md](./AGENTS.md)** 中，它是写给 AI agent 与深度开发者的。**动代码之前请先读它。**

## 提交与 PR 规范

- 一次提交一个逻辑变更，使用常规前缀（`feat:`、`fix:`、`docs:`、`chore:`、`refactor:`），摘要行用祈使句；不显然时在正文解释*为什么*。
- PR 保持小而聚焦。动过代理的 PR 必须附冒烟测试证据。
- 在 PR 描述里注明你测试所用的 DSH 版本（DSH 变化很快）。

## 安全

本插件处理的是**真实会话凭据**（火山方舟控制台 Cookie）。请把它们当作密码：任何文件、任何提交都不得包含真实 Cookie/token——文档与示例一律使用 `PASTE_*` 占位符。完整的强制安全不变量见 [AGENTS.md](./AGENTS.md#security-invariants-mandatory)；包含真实凭据的 PR 将被拒绝。

## 发版流程

1. 在 `package.json` 中按 semver 提升 `version`；功能集有变化时更新 README。
2. 跑完测试全清单 + 敏感信息扫描 + 对 diff 做一次 pro 模型安全审计（详见 [AGENTS.md](./AGENTS.md#release-gate)）。
3. 打标签并发版：

   ```sh
   git tag vX.Y.Z
   git push origin main --tags
   gh release create vX.Y.Z --generate-notes
   ```

## 许可证

通过贡献，你同意你的贡献按本项目的 [MIT](./LICENSE) 许可证授权。
