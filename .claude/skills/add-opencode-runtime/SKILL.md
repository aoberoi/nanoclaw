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
| Session continuity | OpenCode server mode maintains sessions; SDK supports `session.prompt()` for follow-ups |
| CLAUDE.md support | OpenCode natively reads CLAUDE.md files (falls back from AGENTS.md) |
| MCP servers | Native MCP support — nanoclaw MCP server configured in opencode.json |
| Skills/instructions | OpenCode `instructions` config loads additional instruction files |
| Streaming | SSE endpoint provides real-time events via `client.event.subscribe()` |

---

## Implementation

The implementation steps add OpenCode runtime support to the codebase. They are provider/model agnostic — group configuration happens after.

### Step 1: Update Types

Read `src/types.ts` and extend `ContainerConfig`:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  runtime?: 'claude' | 'opencode';        // default: 'claude'
  opencodeConfig?: {
    provider?: string;     // e.g. 'opencode', 'openrouter', 'anthropic'
    apiKey?: string;       // Env var NAME (e.g. "OPENROUTER_API_KEY"); omit for free-tier providers
    model?: string;        // e.g. 'opencode/kimi-k2.5-free', 'openrouter/moonshotai/kimi-k2.5'
  };
}
```

### Step 2: Update Dockerfile

Read `container/Dockerfile` and make two changes:

**2a.** Add OpenCode to the global npm install line:

```dockerfile
# Install agent-browser, claude-code, and opencode globally
RUN npm install -g agent-browser @anthropic-ai/claude-code opencode-ai
```

**2b.** In the `RUN printf ...` entrypoint block, change the final `node` invocation to run from `/workspace/group` instead of the compilation directory (`/app`). This ensures the process cwd is the group workspace, so OpenCode can discover `opencode.json` and `CLAUDE.md` via cwd (the Claude runtime is unaffected — it passes `cwd` explicitly to the SDK):

```
# Before (last line of the printf):
node /tmp/dist/index.js < /tmp/input.json

# After:
cd /workspace/group && node /tmp/dist/index.js < /tmp/input.json
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
3. Creates a session, sends the prompt via `client.session.prompt()`
4. Captures streaming text via `client.event.subscribe()` SSE as a fallback
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

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
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
// Per-prompt timeout. If the model API stalls, session.prompt() blocks
// indefinitely — the Claude runner is unaffected because the Agent SDK manages
// its own timeouts internally. On timeout the container exits so the host queue
// can spawn a fresh one. (CONTAINER_TIMEOUT is host-side and not available here.)
const PROMPT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

class PromptTimeoutError extends Error {
  constructor() {
    super(`session.prompt() timed out after ${PROMPT_TIMEOUT_MS / 1000}s`);
    this.name = 'PromptTimeoutError';
  }
}

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

  // Resolve API key from secrets (only if explicitly configured; omit for free-tier providers)
  const apiKey = oc?.apiKey && containerInput.secrets?.[oc.apiKey]
    ? containerInput.secrets[oc.apiKey]
    : undefined;

  // MCP server path (compiled dist location at container runtime)
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
    // Non-main groups also get the global CLAUDE.md (matches Claude runtime behaviour).
    instructions: [
      'CLAUDE.md',
      ...(!containerInput.isMain && fs.existsSync('/workspace/global/CLAUDE.md')
        ? ['/workspace/global/CLAUDE.md']
        : []),
    ],
  };

  const configPath = '/workspace/group/opencode.json';
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  log(`Wrote opencode.json to ${configPath}`);
}

/**
 * Extract text from message parts.
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

  // Set project directory for OpenCode server
  process.env.OPENCODE_PROJECT = '/workspace/group';

  // Start OpenCode server and get client
  const { client, server } = await createOpencode({
    hostname: '127.0.0.1',
    port: 4096,
    config: {
      model: containerInput.opencodeConfig?.model || 'anthropic/claude-sonnet-4-20250514',
    },
  });

  log('OpenCode server started');

  try {
    // Create a session
    const sessionResult = await client.session.create({
      body: { title: `nanoclaw-${containerInput.groupFolder}` },
    });
    if (sessionResult.error) {
      throw new Error(`Failed to create session: ${JSON.stringify(sessionResult.error)}`);
    }
    const sessionId = sessionResult.data!.id;
    log(`Session created: ${sessionId}`);

    // Set up SSE event stream.
    // session.prompt() is a blocking HTTP call that returns the full response in response.data.parts.
    // The SSE stream runs concurrently and populates lastAssistantText as a fallback in case
    // response.data.parts is empty. Each message.part.updated event carries the full accumulated
    // text in part.text (not a delta), so we overwrite rather than append.
    const eventResult = await client.event.subscribe();
    const eventStream = eventResult.stream;
    let lastAssistantText = '';

    const eventProcessor = (async () => {
      try {
        for await (const event of eventStream) {
          const evt = event as { type?: string; properties?: Record<string, unknown> };
          if (evt.type === 'message.part.updated') {
            const part = (evt.properties?.part) as { type: string; text?: string } | undefined;
            if (part?.type === 'text' && part.text) {
              lastAssistantText = part.text;
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
      log(`Draining ${pending.length} pending IPC messages into initial prompt`);
      prompt += '\n' + pending.join('\n');
    }

    // Query loop: send prompt → wait for IPC → repeat
    while (true) {
      log(`Sending prompt (${prompt.length} chars)...`);
      lastAssistantText = '';

      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new PromptTimeoutError()), PROMPT_TIMEOUT_MS),
        );
        const response = await Promise.race([
          client.session.prompt({
            path: { id: sessionId },
            body: {
              parts: [{ type: 'text' as const, text: prompt }],
            },
          }),
          timeoutPromise,
        ]);

        // Primary: extract text from response body parts.
        // Fallback: use lastAssistantText captured from SSE events (populated concurrently
        // during the blocking session.prompt() call).
        let result: string | null = null;
        if (response.data?.parts) {
          result = extractText(response.data.parts as Array<{ type: string; text?: string }>) || null;
        }
        if (!result && lastAssistantText) {
          result = lastAssistantText;
        }

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
        if (err instanceof PromptTimeoutError) {
          log('Prompt timed out — exiting container so host can spawn a fresh one');
          break;
        }
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

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }

    // Clean up — signal the async generator to stop
    await eventStream.return(undefined as never).catch(() => {});
    await eventProcessor.catch(() => {});
  } finally {
    server.close();
    log('OpenCode server stopped');
  }
}
```

**IMPORTANT IMPLEMENTATION NOTES:**

See [`opencode-sdk-reference.md`](./opencode-sdk-reference.md) in this skill folder for full SDK interface documentation. Key points:

- `createOpencode` starts both the OpenCode server and returns a connected client. Set `process.env.OPENCODE_PROJECT` before calling it to point OpenCode at the workspace directory. Do not pass `cwd` — it is not a supported option.
- `client.session.create({body: {title}})` returns `{data, error}` — check `.error` and use `.data!.id`.
- `client.session.prompt()` is a **blocking HTTP call** (`POST /session/{id}/message`) that waits for the full LLM response and returns `{ info, parts }` in `response.data`. Do not confuse it with `session.promptAsync()`, which is fire-and-forget and returns void. Wrap with `Promise.race()` and a `PromptTimeoutError` to guard against stalled API calls — on timeout, write an error output and `break` so the container exits and the host queue can spawn a fresh one.
- `client.event.subscribe()` returns `{ stream: AsyncGenerator<Event> }`. Each `message.part.updated` event carries `{ part: { type, text }, delta? }` where `part.text` is the **full accumulated text** so far (not a delta). Use `stream.return()` to clean up.
- The SSE stream runs concurrently during `await session.prompt()` via Node.js's event loop, so `lastAssistantText` is populated by the time `session.prompt()` resolves.
- For free-tier providers (e.g. OpenCode Zen), do not set `apiKey` in the config — omit the field entirely. See the reference doc for provider config examples.

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

**6c.** Before writing stdin, pass runtime config; clean up after:
```typescript
input.runtime = group.containerConfig?.runtime;
input.opencodeConfig = group.containerConfig?.opencodeConfig;
container.stdin.write(JSON.stringify(input));
container.stdin.end();
delete input.opencodeConfig;
```

### Step 7: Rebuild Container

```bash
./container/build.sh
```

Verify OpenCode is installed:
```bash
docker run --rm --entrypoint opencode nanoclaw-agent:latest --version
```

### Step 8: Build Host Code

```bash
npm run build
```

---

## Group Configuration

After implementing, **use AskUserQuestion** to ask:

> The OpenCode runtime is now available. Would you like to configure a group to use it now?

If yes, gather:

1. **Which group?** — read `src/db.ts` to understand the schema, then list registered groups from `data/db.sqlite` via sqlite3 CLI
2. **Which provider?**
   - OpenCode Zen (Recommended) — free Kimi K2.5, no API key needed
   - OpenRouter — single key for 200+ models
   - Anthropic — use existing Anthropic API key
   - Custom — any OpenAI-compatible endpoint
3. **API key** — if using OpenRouter or custom; look up the env var name from `.env`; add the key if it doesn't exist yet
4. **Which model?** — suggest `opencode/kimi-k2.5-free` for Zen, `openrouter/moonshotai/kimi-k2.5` for OpenRouter

Then update the group's `containerConfig` in the database via sqlite3 CLI. Example:

```bash
# OpenCode Zen (free, no API key)
sqlite3 data/db.sqlite "UPDATE groups SET container_config = json_patch(COALESCE(container_config, '{}'), '{\"runtime\":\"opencode\",\"opencodeConfig\":{\"provider\":\"opencode\",\"model\":\"opencode/kimi-k2.5-free\"}}') WHERE folder = 'your-group-folder';"

# OpenRouter
sqlite3 data/db.sqlite "UPDATE groups SET container_config = json_patch(COALESCE(container_config, '{}'), '{\"runtime\":\"opencode\",\"opencodeConfig\":{\"provider\":\"openrouter\",\"apiKey\":\"OPENROUTER_API_KEY\",\"model\":\"openrouter/moonshotai/kimi-k2.5\"}}') WHERE folder = 'your-group-folder';"
```

After configuring, ask:

> Would you like the sqlite3 commands to configure this on a remote server later?

If yes, emit the exact sqlite3 command(s) they would need to run on the server.

---

## Rollback

To revert a group to Claude Code, remove `runtime` and `opencodeConfig` from its `containerConfig`:

```bash
sqlite3 data/db.sqlite "UPDATE groups SET container_config = json_remove(json_remove(COALESCE(container_config, '{}'), '$.runtime'), '$.opencodeConfig') WHERE folder = 'your-group-folder';"
```

No code changes needed — the default runtime is `'claude'`.

## Compatibility Notes

| Claude Code feature | OpenCode equivalent | Notes |
|--------------------|--------------------|----|
| CLAUDE.md | Read natively | Falls back from AGENTS.md |
| Container skills (.claude/skills/) | Agent Skills Standard | Same paths, same SKILL.md format |
| MCP servers | Native MCP support | Same nanoclaw MCP server reused via opencode.json |
| Hooks (sanitize bash) | Permission config | Container is already sandboxed; opencode permissions set to allow-all |
| Session persistence | Built-in | OpenCode server mode maintains sessions automatically |
