# Atlarix CLI — an AI coding agent in your terminal

Atlarix is an AI coding agent by [NorahLabs](https://norahlabs.com). The CLI is the same agent
as the [Atlarix desktop app](https://atlarix.dev), in your terminal: it reads your project,
plans, edits files with a diff you approve, runs commands in a sandbox, and reviews and debugs
code. Your sessions, models, API keys, MCP servers and automations are shared with the app.

```sh
npm i -g atlarix
atlarix
```

Other ways to install: `curl -fsSL https://atlarix.dev/install | sh` (macOS, Linux),
`irm https://atlarix.dev/install.ps1 | iex` (Windows), `brew install amariahak/atlarix/atlarix`,
or winget. The CLI updates itself.

## What it does

- **Works in any folder.** Run `atlarix` in a project and ask: "fix the failing test",
  "explain the auth flow", "add a health endpoint".
- **Five work modes.** Build, Explore, Plan, Debug and Review (shift+tab switches).
- **Any model.** Atlarix Auto and the Atlarix Core models, your own API key for any provider
  (OpenAI, Anthropic, Google, DeepSeek, OpenRouter and more), or a local model with Ollama or
  LM Studio.
- **Nothing changes without you.** File edits show a diff to approve; shell commands run in a
  per-OS sandbox.
- **Sub-agents and background work.** Hand independent tasks to sub-agents; follow and stop
  background commands from the strip above the prompt box.
- **Relics.** Ask for a report, plan or design as a shareable page.
- **Batch mode for CI.** `atlarix run --prompt "…"` runs one task unattended and exits; it is
  what powers the [Atlarix cloud agent](https://atlarix.dev/cloud-agent) in GitHub Actions.

## Sign in

`atlarix` opens your browser to sign in; `atlarix login --device` signs in from a machine
without one. Your own API key or a local model works without an Atlarix account.

## Links

- Product page: https://atlarix.dev/cli
- Docs: https://atlarix.dev/docs
- Changelog: https://atlarix.dev/changelog
- Pricing: https://atlarix.dev/pricing
- Issues: https://github.com/AmariahAK/atlarix-releases/issues

Atlarix is proprietary software by NorahLabs (Nairobi, Kenya).
