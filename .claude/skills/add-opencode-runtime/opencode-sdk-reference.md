# @opencode-ai/sdk v1.2.6 — Interface Reference

This reference was derived from the package's TypeScript type definitions (npm tarball inspection). Covers the subset of the API used by the nanoclaw OpenCode runner.

---

## `createOpencode(options)` — Start server + get client

```typescript
import { createOpencode } from '@opencode-ai/sdk';

const { client, server } = await createOpencode({
  hostname: '127.0.0.1',   // bind address for the local OpenCode server
  port: 4096,              // port to listen on
  config?: {
    model?: string;        // default model (e.g. 'anthropic/claude-sonnet-4-20250514')
  },
  // NOTE: 'cwd' is NOT a supported option — set process.env.OPENCODE_PROJECT instead
});
```

**Returns:** `{ client: OpencodeClient, server: { close(): void } }`

Set `process.env.OPENCODE_PROJECT = '/path/to/workspace'` before calling to control which directory OpenCode treats as the project root.

Call `server.close()` in a `finally` block to shut down the server process cleanly.

---

## `client.session`

### `session.create(options)` — Create a new session

```typescript
const result = await client.session.create({
  body?: {
    title?: string;   // human-readable label for the session
  },
});

// result shape:
result.error  // truthy on failure — check before using result.data
result.data   // { id: string, ... } on success

const sessionId = result.data!.id;
```

### `session.prompt(options)` — Send a message, wait for full response

```typescript
const response = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: Array<TextPartInput | FilePartInput | ...>;
    messageID?: string;
    model?: { providerID: string; modelID: string };
    // ... other optional fields
  },
});

// response.data shape (on 200):
// { info: AssistantMessage, parts: Array<Part> }

// Extract text:
const parts = response.data?.parts ?? [];
const text = parts
  .filter(p => p.type === 'text' && p.text)
  .map(p => p.text!)
  .join('');
```

**This is a blocking long-poll.** It hits `POST /session/{id}/message` and only resolves when the LLM has finished generating. The full response is in `response.data.parts`.

Do not confuse with `session.promptAsync()` — that hits `/session/{id}/prompt_async`, returns `void` immediately (fire-and-forget), and delivers the response only via SSE events.

### `TextPartInput` — input part shape

```typescript
{ type: 'text', text: string }
```

---

## `client.event`

### `event.subscribe()` — Subscribe to the SSE event stream

```typescript
const { stream } = await client.event.subscribe();
// stream: AsyncGenerator<Event, void, unknown>

for await (const event of stream) {
  // event is the discriminated Event union — switch on event.type
}

// Cleanup:
await stream.return(undefined as never).catch(() => {});
```

The stream is a persistent connection to the OpenCode server. It emits events for all activity across all sessions on the server instance.

---

## Event types

All events have the shape `{ type: string; properties: <event-specific> }`.

### Events relevant to nanoclaw

| Type | Properties | Notes |
|------|-----------|-------|
| `"message.part.updated"` | `{ part: Part, delta?: string }` | Fires as the assistant streams its reply |
| `"message.updated"` | `{ info: Message }` | Fires when a full message is updated |
| `"session.idle"` | `{ sessionID: string }` | Signals the session has finished processing |
| `"session.error"` | `{ sessionID?: string, error?: unknown }` | Session-level error |
| `"session.status"` | `{ sessionID: string, status: SessionStatus }` | Status transitions |

### Full event type list (for reference)

`"server.instance.disposed"`, `"installation.updated"`, `"installation.update-available"`, `"lsp.client.diagnostics"`, `"lsp.updated"`, `"message.updated"`, `"message.removed"`, `"message.part.updated"`, `"message.part.removed"`, `"permission.updated"`, `"permission.replied"`, `"session.status"`, `"session.idle"`, `"session.compacted"`, `"session.diff"`, `"session.error"`, `"session.created"`, `"session.updated"`, `"session.deleted"`, `"file.edited"`, `"file.watcher.updated"`, `"vcs.branch.updated"`, `"todo.updated"`, `"command.executed"`, `"tui.prompt.append"`, `"tui.command.execute"`, `"tui.toast.show"`, `"pty.created"`, `"pty.updated"`, `"pty.exited"`, `"pty.deleted"`, `"server.connected"`

---

## `message.part.updated` event — detailed shape

```typescript
{
  type: 'message.part.updated',
  properties: {
    part: Part,      // full Part object — see below
    delta?: string,  // optional: only the newly generated characters (incremental)
  }
}
```

### `Part` — text variant

```typescript
{
  type: 'text',
  text: string,    // FULL accumulated text so far (not a delta)
  time: number,    // creation timestamp
  delta?: string,  // optional incremental update
}
```

**Key behavior:** `part.text` always contains the **complete accumulated text** up to this event, not just the new characters. `delta` (if present) holds only the new characters. To capture the latest full text, overwrite rather than append:

```typescript
if (evt.type === 'message.part.updated') {
  const part = evt.properties.part;
  if (part.type === 'text' && part.text) {
    lastAssistantText = part.text;  // overwrite, not +=
  }
}
```

---

## Typing events from the stream

The SDK uses a discriminated union for `Event`. Because the nanoclaw runner casts via `unknown`, use this pattern:

```typescript
for await (const event of stream) {
  const evt = event as { type?: string; properties?: Record<string, unknown> };

  if (evt.type === 'message.part.updated') {
    const part = evt.properties?.part as { type: string; text?: string } | undefined;
    if (part?.type === 'text' && part.text) {
      // part.text is the full accumulated response text
    }
  }

  if (evt.type === 'session.idle') {
    const { sessionID } = evt.properties as { sessionID: string };
    // session finished processing
  }
}
```

---

## `opencode.json` config file

Written to the workspace root before starting the server. OpenCode reads it on startup.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode/kimi-k2.5-free",
  "permission": {
    "edit": "allow",
    "bash": "allow",
    "webfetch": "allow"
  },
  "provider": {
    "opencode": {}
  },
  "mcp": {
    "my-server": {
      "type": "local",
      "command": ["node", "/path/to/server.js"],
      "environment": {
        "MY_VAR": "value"
      }
    }
  },
  "instructions": ["CLAUDE.md"]
}
```

**Provider examples:**

| Provider | `provider` key | `model` format | API key needed? |
|----------|---------------|----------------|-----------------|
| OpenCode Zen | `"opencode"` | `"opencode/kimi-k2.5-free"` | No |
| OpenRouter | `"openrouter"` | `"openrouter/moonshotai/kimi-k2.5"` | Yes |
| Anthropic | `"anthropic"` | `"anthropic/claude-sonnet-4-20250514"` | Yes (or uses env) |

To pass an API key, add it under the provider object:
```json
"provider": {
  "openrouter": { "apiKey": "sk-or-..." }
}
```

For providers that read from environment variables (e.g. `ANTHROPIC_API_KEY`), the key field can be omitted entirely.
