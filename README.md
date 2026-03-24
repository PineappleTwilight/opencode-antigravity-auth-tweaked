# Antigravity + Gemini CLI OAuth Plugin for Opencode

[![npm version](https://img.shields.io/npm/v/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![npm beta](https://img.shields.io/npm/v/opencode-antigravity-auth/beta.svg?label=beta)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![npm downloads](https://img.shields.io/npm/dw/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![X (Twitter)](https://img.shields.io/badge/X-@dopesalmon-000000?style=flat&logo=x)](https://x.com/dopesalmon)

Enable Opencode to authenticate against **Antigravity** (Google's IDE) via OAuth so you can use Antigravity rate limits and access models like `gemini-3.1-pro` and `claude-opus-4-6-thinking` with your Google credentials.

## What You Get

- **Claude Opus 4.6, Sonnet 4.6** and **Gemini 3.1 Pro/Flash** via Google OAuth
- **Multi-account support** — add multiple Google accounts, auto-rotates when rate-limited
- **Dual quota system** — access both Antigravity and Gemini CLI quotas from one plugin
- **Thinking models** — extended thinking for Claude and Gemini 3 with configurable budgets
- **Google Search grounding** — enable web search for Gemini models (auto or always-on)
- **Auto-recovery** — handles session errors and tool failures automatically
- **Plugin compatible** — works alongside other OpenCode plugins (oh-my-opencode, dcp, etc.)

---

<details open>
<summary><b>⚠️ Terms of Service Warning — Read Before Installing</b></summary>

> [!CAUTION]
> Using this plugin (and any proxy for antgravity) violate Google's Terms of Service. A number of users have reported their Google accounts being **banned** or **shadow-banned** (restricted access without explicit notification).
>
> **By using this plugin, you acknowledge:**
> - This is an unofficial tool not endorsed by Google
> - Your account may be suspended or permanently banned
> - You assume all risks associated with using this plugin
>

</details>

---

## Quick Start

1.  **Install the plugin** by adding it to your `~/.config/opencode/opencode.json`:

    ```json
    {
      "plugin": ["opencode-antigravity-auth-tweaked@latest"]
    }
    ```

2.  **Authenticate** with your Google account:

    ```bash
    opencode auth login
    ```

3.  **Configure models** by selecting **"Configure models in opencode.json"** during the login flow. This automatically adds all supported model definitions to your configuration.

4.  **Verify** the installation:

    ```bash
    opencode run "Hello" --model=google/antigravity-claude-opus-4-6-thinking --variant=high
    ```

---

## Models

The plugin provides access to two distinct quota pools: **Antigravity** (IDE) and **Gemini CLI**.

| Model                                | Quota Pool  | Variants                   |
| ------------------------------------ | ----------- | -------------------------- |
| `antigravity-gemini-3-pro`             | Antigravity | low, high                  |
| `antigravity-gemini-3-flash`           | Antigravity | minimal, low, medium, high |
| `antigravity-claude-sonnet-4-6`        | Antigravity | —                          |
| `antigravity-claude-opus-4-6-thinking` | Antigravity | low, high                  |
| `gemini-3-pro-preview`                 | Gemini CLI  | —                          |
| `gemini-3-flash-preview`               | Gemini CLI  | —                          |

> **Note**: For the full list of models and detailed variant configuration, see [docs/MODEL-VARIANTS.md](docs/MODEL-VARIANTS.md). It is highly recommended to use `opencode auth login` to automatically manage these definitions.

---

## Advanced Setup

- **Multi-Account**: Add multiple Google accounts to increase your combined quota and enable automatic rotation. See [docs/MULTI-ACCOUNT.md](docs/MULTI-ACCOUNT.md).
- **Configuration**: Customize behavior such as session recovery, quota thresholds, and account rotation strategies in `antigravity.json`. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- **Plugin Compatibility**: For details on using this plugin with `oh-my-opencode`, `opencode-dcp`, and others, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

---

## Troubleshooting

> **Quick Reset**: Most issues can be resolved by deleting `~/.config/opencode/antigravity-accounts.json` and running `opencode auth login` again.

For solutions to common issues (auth problems, 403 errors, MCP server conflicts, etc.), please refer to the [Troubleshooting Guide](docs/TROUBLESHOOTING.md).

---

## Documentation

- [Configuration](docs/CONFIGURATION.md) — All configuration options
- [Multi-Account](docs/MULTI-ACCOUNT.md) — Load balancing, dual quota pools, account storage
- [Model Variants](docs/MODEL-VARIANTS.md) — Thinking budgets and variant system
- [Troubleshooting](docs/TROUBLESHOOTING.md) — Common issues and fixes
- [Architecture](docs/ARCHITECTURE.md) — How the plugin works
- [API Spec](docs/ANTIGRAVITY_API_SPEC.md) — Antigravity API reference

---

## Credits

- [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) by [@jenslys](https://github.com/jenslys)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)

## License

MIT License. See [LICENSE](LICENSE) for details.

<details>
<summary><b>Legal</b></summary>

### Intended Use

- Personal / internal development only
- Respect internal quotas and data handling policies
- Not for production services or bypassing intended limits

### Warning

By using this plugin, you acknowledge:

- **Terms of Service risk** — This approach may violate ToS of AI model providers
- **Account risk** — Providers may suspend or ban accounts
- **No guarantees** — APIs may change without notice
- **Assumption of risk** — You assume all legal, financial, and technical risks

### Disclaimer

- Not affiliated with Google. This is an independent open-source project.
- "Antigravity", "Gemini", "Google Cloud", and "Google" are trademarks of Google LLC.

</details>
