# Jev Auto for T3 Code

Jev selects a connected native agent, its model and effort, relevant skills, and a proportional collaboration approach. The coordinating agent can use bounded Jev-routed specialists. Main-chat milestones and the native checklist show team progress; approvals and questions are forwarded from the bound task family.

Start with [macOS setup](docs/macos-setup.md). Install the single pinned dependency with `npm ci --ignore-scripts`; `node macos-setup.mjs check` is read-only, and `node macos-setup.mjs install --set-default` registers the addon. Each person connects their own native providers/MCP tools and supplies their own sensitive `TYPESAFE_API_KEY` in T3. Existing Macs can deliberately reuse their own pre-existing Pi or Keychain Jev credential store; those stores are never copied into this package.

**Use T3 permissions** is an informational ACP mode. T3's actual **Permissions** control is authoritative. **Full access** skips routine command/edit prompts; **Auto** can still ask with some providers. Native plan-only mode, sign-ins and genuine questions remain meaningful.

The 33 starter skill folders retain their source records and licenses. Existing user-installed skills take precedence; bundled skills are a fallback. No accounts, API keys, chat databases, local runtime state, personal project material or machine-specific API wrappers are included. The addon follows the repository's MIT license; third-party skills retain their own license and NOTICE terms.

Run `npm test` and `npm run audit`. Maintainers regenerate `files.sha256.json` with `node verify-export.mjs --update` after intended changes and check the staged public file set with `node verify-export.mjs --tracked`. Do not format vendored skills or normalize their bytes. The tested live T3 API is the installed 0.1.6 beta; verify compatibility when updating it. The source fork and this addon do not imply a rebuilt or signed desktop app. Attachment forwarding and universal MCP parity are not implemented.
