---
name: add-opencode-runtime
description: Add OpenCode as an alternative agent runtime alongside Claude Code. Enables per-group runtime selection with native MCP support, session persistence, and access to any model provider.
---

# Add OpenCode Runtime

This skill adds OpenCode as an alternative agent runtime alongside Claude Code, giving per-group runtime selection. Uses OpenCode's `createOpencode` SDK for session persistence and SSE streaming, with native MCP support to reuse the nanoclaw MCP server.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Overview

| Concern | Resolution |
|---------|-----------|
| Session continuity | OpenCode server mode maintains sessions; SDK supports `session.chat()` for follow-ups |
| CLAUDE.md support | OpenCode natively reads CLAUDE.md files (falls back from AGENTS.md) |
| MCP servers | Native MCP support — nanoclaw MCP server configured in opencode.json |
| Skills/instructions | OpenCode `instructions` config loads additional instruction files |
| Streaming | SSE endpoint provides real-time events via `client.event.list()` |

---

## Prerequisites

**Use AskUserQuestion** to ask:

1. **Which model provider?**
   - OpenRouter (Recommended) — single API key for 200+ models
   - Anthropic — use existing Anthropic API key with OpenCode runtime
   - Custom — any OpenAI-compatible endpoint

2. **API key** — if using OpenRouter or custom (stored in `.env`)

3. **Which groups to apply to?** — all groups or specific groups

4. **Default runtime?** — set OpenCode as default for new groups, or per-group only

---

## Implementation

### Step 1: Update Types

Read `src/types.ts` and extend `ContainerConfig`:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  modelProvider?: ModelProvider;           // Phase 1 (may already exist)
  runtime?: 'claude' | 'opencode';        // NEW - default: 'claude'
  opencodeConfig?: {                       // NEW
    provider?: string;     // e.g. 'openrouter', 'anthropic'
    apiKey?: string;       // Env var NAME (e.g. "OPENROUTER_API_KEY")
    model?: string;        // e.g. 'openrouter/moonshotai/kimi-k2.5'
  };
}
```

### Step 2: Update Dockerfile

Read `container/Dockerfile` and add OpenCode installation after the claude-code line:

```dockerfile
# Install agent-browser, claude-code, and opencode globally
RUN npm install -g agent-browser @anthropic-ai/claude-code opencode-ai
```

### Step 3: Add SDK Dependency

Read `container/agent-runner/package.json` and add:

```json
"@opencode-ai/sdk": "^1.2.6"
```

Then the Dockerfile's `npm install` will pick it up on rebuild.

### Step 4: Create OpenCode Runner

Create `container/agent-runner/src/opencode-runner.ts` with the following implementation.

This file:
1. Starts an OpenCode server via `createOpencode` SDK
2. Writes `opencode.json` to the workspace with provider/model/MCP/permissions config
3. Creates a session, sends the prompt via `client.session.chat()`
4. Streams responses via `client.event.list()` SSE
5. Emits OUTPUT_START/END markers to stdout (same protocol as Claude runner)
6. Handles IPC follow-up messages by sending to the same session
7. Handles `_close` sentinel for graceful shutdown

```typescript
/**
 * OpenCode Agent Runner
 * Alternative runtime that uses OpenCode instead of Claude Code SDK.
 * Same stdin/stdout protocol and IPC mechanism as the Claude runner.
 */

import fs from 'fs';
import path from 'path';
import { createOpencode } from '@opencode-ai/sdk';

// Re-use types/constants from index.ts
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  modelProvider?: { baseUrl?: string; apiKey?: string; model?: string };
  runtime?: string;
  opencodeConfig?: {
    provider?: string;
    apiKey?: string;
    model?: string;
  };
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[opencode-runner] ${message}`);
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Write opencode.json config to the workspace.
 */
function writeOpencodeConfig(containerInput: ContainerInput): void {
  const oc = containerInput.opencodeConfig;
  const provider = oc?.provider || 'anthropic';
  const model = oc?.model || 'anthropic/claude-sonnet-4-20250514';

  // Resolve API key from secrets
  const apiKey = oc?.apiKey && containerInput.secrets?.[oc.apiKey]
    ? containerInput.secrets[oc.apiKey]
    : containerInput.secrets?.['ANTHROPIC_API_KEY'] || '';

  // Build the MCP server path (same as Claude runner uses)
  const mcpServerPath = '/tmp/dist/ipc-mcp-stdio.js';

  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    model,
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
    },
    provider: {
      [provider]: {
        ...(apiKey ? { apiKey } : {}),
      },
    },
    mcp: {
      nanoclaw: {
        type: 'local',
        command: ['node', mcpServerPath],
        environment: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    },
    // Load CLAUDE.md and any additional instruction files
    instructions: ['CLAUDE.md'],
  };

  const configPath = '/workspace/group/opencode.json';
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  log(`Wrote opencode.json to ${configPath}`);
}

/**
 * Extract text from assistant message parts.
 */
function extractText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter(p => p.type === 'text' && p.text)
    .map(p => p.text!)
    .join('');
}

export async function runOpenCode(containerInput: ContainerInput): Promise<void> {
  log('Starting OpenCode runtime...');

  // Write opencode.json configuration
  writeOpencodeConfig(containerInput);

  // Start OpenCode server and get client
  const { client, server } = await createOpencode({
    cwd: '/workspace/group',
    hostname: '127.0.0.1',
    port: 4096,
    config: {
      model: containerInput.opencodeConfig?.model || 'anthropic/claude-sonnet-4-20250514',
    },
  });

  log('OpenCode server started');

  try {
    // Create a session
    const session = await client.session.create();
    const sessionId = session.id;
    log(`Session created: ${sessionId}`);

    // Set up SSE event stream for real-time updates
    const eventStream = await client.event.list();
    let lastAssistantText = '';

    // Process events in background
    const eventProcessor = (async () => {
      try {
        for await (const event of eventStream) {
          if (event.type === 'message.updated') {
            // Capture assistant text as it streams in
            const info = (event as { properties?: { info?: { parts?: Array<{ type: string; text?: string }> } } }).properties?.info;
            if (info?.parts) {
              lastAssistantText = extractText(info.parts);
            }
          }
        }
      } catch {
        // Stream ended or aborted
      }
    })();

    // Build initial prompt
    let prompt = containerInput.prompt;
    if (containerInput.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }
    const pending = drainIpcInput();
    if (pending.length > 0) {
      prompt += '\n' + pending.join('\n');
    }

    // Query loop
    while (true) {
      log(`Sending prompt (${prompt.length} chars)...`);
      lastAssistantText = '';

      try {
        const response = await client.session.chat(sessionId, {
          parts: [{ type: 'text', text: prompt }],
        });

        // Extract result from response
        const result = response?.parts
          ? extractText(response.parts)
          : lastAssistantText || null;

        log(`Got response: ${result ? result.slice(0, 200) : '(empty)'}...`);

        writeOutput({
          status: 'success',
          result,
          newSessionId: sessionId,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log(`Query error: ${errorMessage}`);
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: errorMessage,
        });
      }

      // Check for close before waiting
      if (shouldClose()) {
        log('Close sentinel received after query, exiting');
        break;
      }

      // Wait for next IPC message or close
      log('Waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      prompt = nextMessage;
    }

    // Clean up
    eventStream.controller.abort();
    await eventProcessor.catch(() => {});
  } finally {
    server.close();
    log('OpenCode server stopped');
  }
}
```

**IMPORTANT IMPLEMENTATION NOTES:**

- The `createOpencode` function from `@opencode-ai/sdk` starts both the server and returns a connected client in one call.
- The `client.session.chat()` method sends a message and waits for the complete response.
- SSE events via `client.event.list()` provide real-time streaming updates.
- The opencode.json file is written to `/workspace/group/` which is the cwd.
- IPC handling (poll/drain/close) uses the exact same mechanism as the Claude runner.
- The OUTPUT_START/END marker protocol is identical, so the host container-runner doesn't need any changes to output parsing.

### Step 5: Add Runtime Dispatch

Read `container/agent-runner/src/index.ts` and add runtime dispatch at the start of `main()`, right after parsing stdin and before the SDK env setup:

```typescript
// Runtime dispatch: use OpenCode if configured
if (containerInput.runtime === 'opencode') {
  const { runOpenCode } = await import('./opencode-runner.js');
  await runOpenCode(containerInput);
  return;
}
```

Place this right after `log(\`Received input for group: ${containerInput.groupFolder}\`)` and before `// Build SDK env`.

Also add `runtime` and `opencodeConfig` to the `ContainerInput` interface:
```typescript
interface ContainerInput {
  // ...existing fields...
  runtime?: 'claude' | 'opencode';
  opencodeConfig?: {
    provider?: string;
    apiKey?: string;
    model?: string;
  };
}
```

### Step 6: Update Container Runner (Host Side)

Read `src/container-runner.ts` and update:

**6a.** Add `runtime` and `opencodeConfig` to the `ContainerInput` interface:
```typescript
runtime?: 'claude' | 'opencode';
opencodeConfig?: {
  provider?: string;
  apiKey?: string;
  model?: string;
};
```

**6b.** In `readSecrets()`, also read the OpenCode provider API key:
```typescript
const opencodeApiKey = group?.containerConfig?.opencodeConfig?.apiKey;
if (opencodeApiKey && !keys.includes(opencodeApiKey)) {
  keys.push(opencodeApiKey);
}
```

**6c.** Before writing stdin, pass runtime config:
```typescript
input.runtime = group.containerConfig?.runtime;
input.opencodeConfig = group.containerConfig?.opencodeConfig;
```

### Step 7: Rebuild Container

```bash
./container/build.sh
```

Verify OpenCode is installed:
```bash
docker run --rm --entrypoint opencode nanoclaw-agent:latest --version
```

### Step 8: Configure Group(s)

Update the group's `containerConfig` in the database. Example for OpenRouter + Kimi K2.5:

```json
{
  "runtime": "opencode",
  "opencodeConfig": {
    "provider": "openrouter",
    "apiKey": "OPENROUTER_API_KEY",
    "model": "openrouter/moonshotai/kimi-k2.5"
  }
}
```

### Step 9: Build Host Code

```bash
npm run build
```

### Step 10: Test

Tell the user:

> OpenCode runtime configured! Send a message to the configured group to test.
>
> - Groups with `runtime: 'opencode'` will use OpenCode with the configured model
> - Groups without `runtime` set (or `runtime: 'claude'`) continue using Claude Code
> - Both runtimes share the same IPC protocol, so MCP tools, messaging, and scheduling all work identically

---

## Rollback

To revert a group to Claude Code, remove `runtime` and `opencodeConfig` from its `containerConfig`. No code changes needed — the default runtime is `'claude'`.

## Compatibility Notes

| Claude Code feature | OpenCode equivalent | Notes |
|--------------------|--------------------|----|
| CLAUDE.md | Read natively | Falls back from AGENTS.md |
| Container skills (.claude/skills/) | Agent Skills Standard | Same paths, same SKILL.md format |
| MCP servers | Native MCP support | Same nanoclaw MCP server reused via opencode.json |
| Hooks (sanitize bash) | Permission config | Container is already sandboxed; opencode permissions set to allow-all |
| Session persistence | Built-in | OpenCode server mode maintains sessions automatically |
