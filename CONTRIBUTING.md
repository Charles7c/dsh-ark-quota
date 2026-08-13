# Contributing to dsh-ark-quota

English | [简体中文](./CONTRIBUTING.zh-CN.md)

Thank you for your interest in contributing to `dsh-ark-quota`! This plugin is part of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ecosystem, where **everything is a plugin** (powered by [Cordis](https://github.com/cordiverse/cordis)). The DeepSeek Harness core does not accept external pull requests right now, but **community plugins are the officially encouraged way to extend it** — giving this project a `dsh-plugin` GitHub topic is exactly how the ecosystem discovers each other.

> ⚠️ DeepSeek Harness is in **developer preview** and iterates rapidly — there will be compatibility-breaking changes. Pin the DSH version you develop against and re-test on upgrade.

## Ways to contribute

- **Report bugs or request features** — open a [GitHub Issue](https://github.com/lordqyxz/dsh-ark-quota/issues) with: DSH version, Node version, OS, the plugin config you used (placeholders for cookies!), and the expected vs. actual behavior. For questions and ideas, use GitHub Discussions.
- **Improve the docs** — README and CONTRIBUTING are maintained in both English and 简体中文; user-facing changes must update both.
- **Write code** — see [Development](#development) below. Code PRs must include their test evidence (see the testing checklist).

## Development

- **Quick start**: clone the repo, point your DSH profile workspace at it, add the entry to `cordis.patch.yml` (see `cordis.patch.yml.example`), run `npx @deepseek-ai/dsh web`.
- **The full technical workflow** — repo layout, how the plugin loads (restart vs. HMR rules), coding conventions, mandatory security invariants, and the testing checklist — lives in **[AGENTS.md](./AGENTS.md)**, written for AI agents and deep-dive developers. **Read it before touching code.**

## Commit & PR guidelines

- One logical change per commit, conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`), imperative summary line, body explaining *why* when non-obvious.
- Keep PRs small and focused. A PR that touches the proxy must come with its smoke-test evidence.
- Note the DSH version you tested against in the PR description (DSH is a moving target).

## Security

This plugin moves **real session credentials** (Volcano Ark console cookies). Treat them as passwords: never commit real cookies/tokens in any file or commit — docs and examples use `PASTE_*` placeholders only. The complete, mandatory security invariants are in [AGENTS.md](./AGENTS.md#security-invariants-mandatory); a PR containing a real credential will be rejected.

## Release process

1. Bump `version` in `package.json` (semver); update README if the feature set changed.
2. Run the full testing checklist + secret scan + a pro-model security review of the diff (details in [AGENTS.md](./AGENTS.md#release-gate)).
3. Tag and release:

   ```sh
   git tag vX.Y.Z
   git push origin main --tags
   gh release create vX.Y.Z --generate-notes
   ```

## License

By contributing you agree your contributions are licensed under the [MIT](./LICENSE) license of this project.
