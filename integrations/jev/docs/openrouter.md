# Use OpenRouter with Jev

Connect OpenRouter through a native OpenCode provider instance named `openrouter-api`. Store `OPENROUTER_API_KEY` as a **sensitive environment variable** in that T3 provider. Keep its OpenCode configuration and profile separate from other API connections; reference the environment variable instead of putting the key in a config file. Use the native OpenRouter runtime, which preserves its model and reasoning behavior.

OpenRouter uses API credits. It is not part of a Claude, Codex or Grok subscription. Jev can select it alongside the other allowed providers, while preferring existing subscriptions when similarly suitable. Set a per-key credit limit in your own OpenRouter account if you want a spending cap. Each person supplies their own credentials; never copy a key into this kit, a chat, or Git.

After T3 shows the connection as authenticated and its models are available, add `openrouter-api` to `allowedInstances` in the installed addon's private `config.json`. This file is excluded from the public export.

For a large catalog, configure `modelAllowlist` in the same file. It maps instance ids to arrays of exact T3 model ids. For example:

```json
{
  "modelAllowlist": {
    "openrouter-api": ["openrouter/google/gemini-3.8-flash"]
  }
}
```

Copy ids from the models your connected T3 runner actually lists. The example is one verified model, not a measured ranking or a guarantee of future availability. An empty or invalid list excludes that provider's models from automatic selection; other providers stay available. Omit a provider from the map to leave its inventory unrestricted. A shortlist affects Jev's automatic choices, while T3's manual model picker can still show the full native catalog. Supported reasoning variants are included in Jev's effort choices.

Use a new chat or reconnect Jev when idle to load an addon update. Keep active work running. The 0.4.3 addon remains compatible with the 0.4.1 custom desktop app.

References: [OpenCode providers](https://opencode.ai/v2/docs/providers), [OpenRouter key limits](https://openrouter.ai/docs/api/reference/limits).
