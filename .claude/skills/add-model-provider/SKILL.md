---
name: add-model-provider
description: Add per-group model/provider configuration to NanoClaw. Routes agent requests through OpenRouter (or any OpenAI-compatible proxy) to use cheaper models like Kimi K2.5, GLM-5, DeepSeek V3.2, or Qwen 3 Coder.
---

# Add Model Provider

This skill adds per-group model/provider configuration by leveraging `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL` env vars to route Claude Agent SDK requests through OpenRouter (or any compatible proxy) to cheaper models.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Cost Context

| Model | Input/Output per 1M tokens | SWE-bench | Available On |
|-------|---------------------------|-----------|--------------|
| Claude Opus 4 | $15 / $75 | ~80% | Anthropic (current) |
| Kimi K2.5 | $0.50 / $2.80 | ~77% | OpenRouter, Fireworks, Together AI |
| GLM-5 (MIT license) | $1 / $3.20 | ~78% | OpenRouter (US/EU infra) |
| DeepSeek V3.2 | $0.25 / $0.38 | ~68% | OpenRouter |
| Qwen 3 Coder | Free (rate-limited) | Competitive | OpenRouter |

Groups without `modelProvider` configured continue using default Anthropic — zero changes to existing behavior.

---

## Prerequisites

**Use AskUserQuestion** to present provider choice:

Question: "Which model provider would you like to use?"
Options:
1. **OpenRouter (Recommended)** — Access to 200+ models via single API key. Get a key at https://openrouter.ai/keys
2. **Custom endpoint** — Any OpenAI-compatible API endpoint (e.g., self-hosted, Fireworks, Together AI)

Wait for the user's choice before continuing.

Then ask for:
- API key (will be stored securely in `.env`)
- Which model to default to (suggest Kimi K2.5 `moonshotai/kimi-k2.5` as best value)
- Apply to all groups or specific groups?

---

## Implementation

### Step 1: Update Types

Read `src/types.ts` and add `modelProvider` to the `ContainerConfig` interface:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  modelProvider?: {
    baseUrl?: string;    // e.g. "https://openrouter.ai/api/v1"
    apiKey?: string;     // Env var NAME to read from .env (e.g. "OPENROUTER_API_KEY")
    model?: string;      // e.g. "moonshotai/kimi-k2.5"
  };
}
```

### Step 2: Update Container Runner

Read `src/container-runner.ts` and make two changes:

**2a.** Update `readSecrets()` to accept an optional group parameter and read the custom API key:

```typescript
function readSecrets(group?: RegisteredGroup): Record<string, string> {
  const keys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
  // If group has a custom provider API key, read that too
  const customApiKey = group?.containerConfig?.modelProvider?.apiKey;
  if (customApiKey && !keys.includes(customApiKey)) {
    keys.push(customApiKey);
  }
  return readEnvFile(keys);
}
```

**2b.** Update the stdin writing section (~line 258) to pass `modelProvider`:

Before `container.stdin.write(JSON.stringify(input))`, add:
```typescript
input.modelProvider = group.containerConfig?.modelProvider;
```

**2c.** Update the `ContainerInput` interface to include `modelProvider`:

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  modelProvider?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
}
```

### Step 3: Update Agent Runner

Read `container/agent-runner/src/index.ts` and make two changes:

**3a.** Add `modelProvider` to the `ContainerInput` interface:

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  modelProvider?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
}
```

**3b.** After building `sdkEnv` (after the secrets loop), inject provider overrides:

```typescript
// Inject model provider overrides (OpenRouter, custom endpoints, etc.)
if (containerInput.modelProvider) {
  const mp = containerInput.modelProvider;
  if (mp.baseUrl) {
    sdkEnv.ANTHROPIC_BASE_URL = mp.baseUrl;
  }
  if (mp.apiKey && containerInput.secrets?.[mp.apiKey]) {
    sdkEnv.ANTHROPIC_API_KEY = containerInput.secrets[mp.apiKey];
  }
  if (mp.model) {
    sdkEnv.ANTHROPIC_MODEL = mp.model;
  }
  log(`Model provider configured: base=${mp.baseUrl || 'default'} model=${mp.model || 'default'}`);
}
```

### Step 4: Add API Key to .env

Read the project `.env` file and add the user's API key. For OpenRouter:

```
OPENROUTER_API_KEY=sk-or-v1-xxxxx
```

### Step 5: Configure Group(s)

Read `data/db.sqlite` group registrations using the existing SQLite database. For each group the user wants to configure, update the `containerConfig` JSON in the groups table.

Example for OpenRouter + Kimi K2.5:
```json
{
  "modelProvider": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKey": "OPENROUTER_API_KEY",
    "model": "moonshotai/kimi-k2.5"
  }
}
```

Use the project's `src/db.ts` to understand the schema, then update via sqlite3 CLI or by reading/modifying the group config.

### Step 6: Build and Verify

```bash
npm run build
```

Confirm no TypeScript errors. The container will pick up agent-runner changes on next run (source is mounted and recompiled at container startup).

### Step 7: Test

Tell the user:
> Model provider configured! Send a message to the configured group to test. The agent will use [model name] via [provider].
>
> Groups without modelProvider configured will continue using your default Anthropic API key.

---

## Rollback

To revert a group to default Anthropic, remove the `modelProvider` from its `containerConfig`. No code changes needed.
