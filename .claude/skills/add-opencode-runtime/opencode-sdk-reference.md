# @opencode-ai/sdk v1.2.9 — Comprehensive Reference

Derived from tarball inspection of `opencode-ai-sdk-1.2.9.tgz` (npm pack). All types are from
`dist/src/gen/types.gen.d.ts` and `dist/src/gen/sdk.gen.d.ts` unless noted.

---

## Package exports

```
@opencode-ai/sdk          → createOpencode(), createOpencodeClient(), all types
@opencode-ai/sdk/client   → createOpencodeClient() only (no server)
@opencode-ai/sdk/server   → createOpencodeServer(), createOpencodeTui()
@opencode-ai/sdk/v2       → v2 API (same shape, some additions — see V2 section)
```

---

## Top-level functions

### `createOpencode(options?)` — start server + get client

```typescript
import { createOpencode } from '@opencode-ai/sdk';

const { client, server } = await createOpencode(options?: ServerOptions);
// server.url: string — e.g. "http://127.0.0.1:4096"
// server.close(): void — kills the server process
```

**ServerOptions:**
```typescript
type ServerOptions = {
  hostname?: string;      // default "127.0.0.1"
  port?: number;          // default 4096
  signal?: AbortSignal;   // for cancellation
  timeout?: number;       // ms to wait for server ready, default 5000
  config?: Config;        // serialized as OPENCODE_CONFIG_CONTENT env var
};
```

**Implementation note:** spawns `opencode serve --hostname=... --port=...` as a subprocess.
Config is passed via `OPENCODE_CONFIG_CONTENT=JSON.stringify(config)` in the environment.
Set `process.env.OPENCODE_PROJECT = '/path'` BEFORE calling to control project root.

### `createOpencodeClient(config?)` — client only, no server

```typescript
import { createOpencodeClient } from '@opencode-ai/sdk/client';

const client = createOpencodeClient({
  baseURL: 'http://127.0.0.1:4096',
  directory?: string,   // project directory filter for queries
});
```

### `createOpencodeServer(options?)` — server only

```typescript
import { createOpencodeServer } from '@opencode-ai/sdk/server';

const { url, close } = await createOpencodeServer(options?: ServerOptions);
```

### `createOpencodeTui(options?)` — launch TUI process

```typescript
import { createOpencodeTui } from '@opencode-ai/sdk/server';

type TuiOptions = {
  project?: string;
  model?: string;
  session?: string;   // open a specific session by ID
  agent?: string;
  signal?: AbortSignal;
  config?: Config;
};

const tui = createOpencodeTui(options?: TuiOptions);
tui.close(); // kill the TUI process
```

---

## `OpencodeClient` — top-level namespace

```typescript
client.session        // Session management (primary API)
client.event          // SSE event stream
client.config         // Server config
client.project        // Project info
client.path           // Filesystem paths
client.vcs            // VCS (git) info
client.tool           // Tool introspection
client.file           // File read/list/status
client.find           // Search (text, files, symbols)
client.app            // App logs, agent list
client.mcp            // MCP server management
client.lsp            // LSP server status
client.formatter      // Formatter status
client.provider       // Provider list/auth
client.pty            // PTY (terminal) sessions
client.instance       // Server instance management
client.command        // Custom command list
client.tui            // TUI control
client.auth           // OAuth / API key auth
client.global         // Global event stream (cross-directory)
client.postSessionIdPermissionsPermissionId(options)  // Respond to permission requests
```

---

## Session API (most important)

### `client.session.list(options?)` — list sessions

```typescript
const result = await client.session.list({
  query?: { directory?: string },
});
// result.data: Array<Session>
// Filtered to sessions whose directory matches the query.directory value.
// Returns ALL sessions for the project if no directory filter is given.
```

**This is key for session persistence:** use this to find existing sessions for a group
after a container restart (filter by `directory: '/workspace/group'`).

### `client.session.create(options?)` — create a new session

```typescript
const result = await client.session.create({
  body?: {
    parentID?: string;   // make this a child of another session
    title?: string;      // human-readable label
  },
  query?: { directory?: string },
});
// result.error — check before using result.data
// result.data: Session
const sessionId = result.data!.id;
```

### `client.session.get(options)` — get session by ID

```typescript
const result = await client.session.get({
  path: { id: string },
  query?: { directory?: string },
});
// result.data: Session
// Returns 404 NotFoundError if session does not exist.
// Use this to verify a stored session ID is still valid.
```

### `client.session.prompt(options)` — send a message, wait for full response

```typescript
const response = await client.session.prompt({
  path: { id: sessionId },
  body?: {
    parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;
    messageID?: string;              // client-supplied ID for idempotency
    model?: { providerID: string; modelID: string };
    agent?: string;                  // agent name to use
    noReply?: boolean;               // send message without waiting for response
    system?: string;                 // override system prompt
    tools?: { [toolName: string]: boolean };
  },
  query?: { directory?: string },
});
// response.data: { info: AssistantMessage; parts: Array<Part> }
```

**BLOCKING long-poll.** Hits `POST /session/{id}/message` and resolves only when the LLM
finishes generating. Full response is in `response.data.parts`.

### `client.session.promptAsync(options)` — fire-and-forget prompt

Hits `/session/{id}/prompt_async`, returns `void` immediately. Response comes via SSE events.
Same body shape as `session.prompt()`.

### `client.session.messages(options)` — list messages in a session

```typescript
const result = await client.session.messages({
  path: { id: sessionId },
  query?: {
    directory?: string;
    limit?: number;
  },
});
// result.data: Array<{ info: Message; parts: Array<Part> }>
```

### `client.session.update(options)` — update session properties

```typescript
await client.session.update({
  path: { id: sessionId },
  body?: { title?: string },
  query?: { directory?: string },
});
// result.data: Session
```

### `client.session.delete(options)` — delete session and all data

```typescript
await client.session.delete({
  path: { id: sessionId },
  query?: { directory?: string },
});
// result.data: boolean
```

### `client.session.abort(options)` — abort in-progress session

```typescript
await client.session.abort({
  path: { id: sessionId },
  query?: { directory?: string },
});
// result.data: boolean
```

### `client.session.fork(options)` — fork session at a message

```typescript
const result = await client.session.fork({
  path: { id: sessionId },
  body?: { messageID?: string },  // fork point; defaults to latest
  query?: { directory?: string },
});
// result.data: Session  (the new child session)
```

### `client.session.children(options)` — get child sessions

```typescript
const result = await client.session.children({
  path: { id: sessionId },
  query?: { directory?: string },
});
// result.data: Array<Session>
```

### `client.session.status(options?)` — get status of all sessions

```typescript
const result = await client.session.status();
// result.data: { [sessionId: string]: SessionStatus }
```

### `client.session.summarize(options)` — trigger summarization

```typescript
await client.session.summarize({
  path: { id: sessionId },
  body?: { providerID: string; modelID: string },
  query?: { directory?: string },
});
// result.data: boolean
```

### `client.session.todo(options)` — get todo list

```typescript
const result = await client.session.todo({
  path: { id: sessionId },
});
// result.data: Array<Todo>
```

### `client.session.diff(options)` — get file diffs

```typescript
const result = await client.session.diff({
  path: { id: sessionId },
  query?: { directory?: string; messageID?: string },
});
// result.data: Array<FileDiff>
```

### `client.session.revert(options)` / `client.session.unrevert(options)` — undo/redo

Revert to or restore from a message snapshot. See SessionRevertData/SessionUnrevertData types.

### `client.session.shell(options)` — run a shell command in session context

### `client.session.command(options)` — send a named command to a session

### `client.session.init(options)` — analyze app and create AGENTS.md

```typescript
await client.session.init({
  path: { id: sessionId },
  body?: { modelID: string; providerID: string; messageID: string },
});
```

### `client.postSessionIdPermissionsPermissionId(options)` — respond to permission request

```typescript
await client.postSessionIdPermissionsPermissionId({
  path: { id: sessionId; permissionId: string },
  body?: { response: 'once' | 'always' | 'reject' },
});
```

---

## Event stream

### `client.event.subscribe()` — subscribe to SSE event stream

```typescript
const { stream } = await client.event.subscribe();
// stream: AsyncGenerator<Event, void, unknown>
// Emits events for ALL sessions on this server instance.

for await (const event of stream) {
  const evt = event as { type?: string; properties?: Record<string, unknown> };
  // switch on evt.type
}

// Cleanup:
await stream.return(undefined as never).catch(() => {});
```

### `client.global.event()` — global event stream (cross-directory)

Same shape as `client.event.subscribe()` but wraps each event as `{ directory, payload }`.

---

## All event types (complete)

```typescript
type Event =
  | EventServerInstanceDisposed       // "server.instance.disposed"
  | EventInstallationUpdated          // "installation.updated"
  | EventInstallationUpdateAvailable  // "installation.update-available"
  | EventLspClientDiagnostics         // "lsp.client.diagnostics"
  | EventLspUpdated                   // "lsp.updated"
  | EventMessageUpdated               // "message.updated"
  | EventMessageRemoved               // "message.removed"
  | EventMessagePartUpdated           // "message.part.updated"  ← streaming text
  | EventMessagePartRemoved           // "message.part.removed"
  | EventPermissionUpdated            // "permission.updated"    ← permission request
  | EventPermissionReplied            // "permission.replied"
  | EventSessionStatus                // "session.status"
  | EventSessionIdle                  // "session.idle"          ← session finished
  | EventSessionCompacted             // "session.compacted"     ← context compacted
  | EventFileEdited                   // "file.edited"
  | EventTodoUpdated                  // "todo.updated"
  | EventCommandExecuted              // "command.executed"
  | EventSessionCreated               // "session.created"
  | EventSessionUpdated               // "session.updated"
  | EventSessionDeleted               // "session.deleted"
  | EventSessionDiff                  // "session.diff"
  | EventSessionError                 // "session.error"
  | EventFileWatcherUpdated           // "file.watcher.updated"
  | EventVcsBranchUpdated             // "vcs.branch.updated"
  | EventTuiPromptAppend              // "tui.prompt.append"
  | EventTuiCommandExecute            // "tui.command.execute"
  | EventTuiToastShow                 // "tui.toast.show"
  | EventPtyCreated                   // "pty.created"
  | EventPtyUpdated                   // "pty.updated"
  | EventPtyExited                    // "pty.exited"
  | EventPtyDeleted                   // "pty.deleted"
  | EventServerConnected;             // "server.connected"
```

### Event property shapes

```typescript
// Streaming text (fires repeatedly during LLM generation)
EventMessagePartUpdated: { part: Part; delta?: string }
// part.text is FULL accumulated text (not a delta) — overwrite, don't append

// Session finished generating
EventSessionIdle: { sessionID: string }

// Context was compacted
EventSessionCompacted: { sessionID: string }

// Session status changed
EventSessionStatus: { sessionID: string; status: SessionStatus }
// SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number }

// Session lifecycle
EventSessionCreated: { info: Session }
EventSessionUpdated: { info: Session }
EventSessionDeleted: { info: Session }

// Permission request (tool needs approval)
EventPermissionUpdated: Permission  // { id, type, pattern?, sessionID, messageID, callID?, title, metadata, time }
EventPermissionReplied: { sessionID: string; permissionID: string; response: string }

// Session error
EventSessionError: { sessionID?: string; error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError }

// Message removed (e.g. after revert)
EventMessageRemoved: { sessionID: string; messageID: string }

// Message updated (full message object)
EventMessageUpdated: { info: Message }

// File changed
EventFileEdited: { file: string }
EventFileWatcherUpdated: { file: string; event: "add" | "change" | "unlink" }

// Todo list updated
EventTodoUpdated: { sessionID: string; todos: Array<Todo> }

// Server instance disposed
EventServerInstanceDisposed: { directory: string }

// TUI events
EventTuiPromptAppend: { text: string }
EventTuiCommandExecute: { command: string }
EventTuiToastShow: { title?: string; message: string; variant: "info"|"success"|"warning"|"error"; duration?: number }
```

---

## Core types

### `Session`

```typescript
type Session = {
  id: string;
  projectID: string;
  directory: string;      // project root directory this session belongs to
  parentID?: string;      // set for child/forked sessions
  title: string;
  version: string;
  time: {
    created: number;      // ms timestamp
    updated: number;
    compacting?: number;  // set when compaction is in progress
  };
  summary?: {
    additions: number;
    deletions: number;
    files: number;
    diffs?: Array<FileDiff>;
  };
  share?: { url: string };
  revert?: {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
  };
};
```

### `Message` (discriminated union)

```typescript
type Message = UserMessage | AssistantMessage;

type UserMessage = {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  agent: string;
  model: { providerID: string; modelID: string };
  system?: string;
  tools?: { [key: string]: boolean };
  summary?: { title?: string; body?: string; diffs: Array<FileDiff> };
};

type AssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  path: { cwd: string; root: string };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  summary?: boolean;       // true if this is a summary/compaction message
  finish?: string;
  error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError;
};
```

### `Part` (discriminated union — all variants)

```typescript
type Part =
  | TextPart          // type: "text"
  | ReasoningPart     // type: "reasoning"
  | FilePart          // type: "file"
  | ToolPart          // type: "tool"
  | StepStartPart     // type: "step-start"
  | StepFinishPart    // type: "step-finish"
  | SnapshotPart      // type: "snapshot"
  | PatchPart         // type: "patch"
  | AgentPart         // type: "agent"
  | RetryPart         // type: "retry"
  | CompactionPart    // type: "compaction"
  | SubtaskPart;      // type: "subtask"  (inline in union)

type TextPart = {
  id: string; sessionID: string; messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: { [key: string]: unknown };
};

type ReasoningPart = {
  id: string; sessionID: string; messageID: string;
  type: "reasoning";
  text: string;
  time: { start: number; end?: number };
  metadata?: { [key: string]: unknown };
};

type ToolPart = {
  id: string; sessionID: string; messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;
  metadata?: { [key: string]: unknown };
};

type ToolStatePending = { status: "pending"; input: Record<string, unknown>; raw: string };
type ToolStateRunning = { status: "running"; input: Record<string, unknown>; title?: string; metadata?: Record<string, unknown>; time: { start: number } };
type ToolStateCompleted = { status: "completed"; input: Record<string, unknown>; output: string; title: string; metadata: Record<string, unknown>; time: { start: number; end: number; compacted?: number }; attachments?: Array<FilePart> };
type ToolStateError = { status: "error"; input: Record<string, unknown>; error: string; metadata?: Record<string, unknown>; time: { start: number; end: number } };

type StepStartPart = { id: string; sessionID: string; messageID: string; type: "step-start"; snapshot?: string };
type StepFinishPart = {
  id: string; sessionID: string; messageID: string;
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
};

type CompactionPart = { id: string; sessionID: string; messageID: string; type: "compaction"; auto: boolean };
// Appears in message.parts when context compaction occurred

type SnapshotPart = { id: string; sessionID: string; messageID: string; type: "snapshot"; snapshot: string };
type PatchPart = { id: string; sessionID: string; messageID: string; type: "patch"; hash: string; files: Array<string> };
type AgentPart = { id: string; sessionID: string; messageID: string; type: "agent"; name: string; source?: { value: string; start: number; end: number } };
type RetryPart = { id: string; sessionID: string; messageID: string; type: "retry"; attempt: number; error: ApiError; time: { created: number } };

// SubtaskPart (inline union member):
// { id: string; sessionID: string; messageID: string; type: "subtask"; prompt: string; description: string; agent: string }
```

### Input part types (for `session.prompt()`)

```typescript
type TextPartInput = { id?: string; type: "text"; text: string; synthetic?: boolean; ignored?: boolean; time?: { start: number; end?: number }; metadata?: Record<string, unknown> };
type FilePartInput = { id?: string; type: "file"; mime: string; filename?: string; url: string; source?: FilePartSource };
type AgentPartInput = { id?: string; type: "agent"; name: string; source?: { value: string; start: number; end: number } };
type SubtaskPartInput = { id?: string; type: "subtask"; prompt: string; description: string; agent: string };
```

### `SessionStatus`

```typescript
type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };
```

### Error types

```typescript
type ProviderAuthError = { name: "ProviderAuthError"; data: { providerID: string; message: string } };
type UnknownError = { name: "UnknownError"; data: { message: string } };
type MessageOutputLengthError = { name: "MessageOutputLengthError"; data: Record<string, unknown> };
type MessageAbortedError = { name: "MessageAbortedError"; data: { message: string } };
type ApiError = { name: "APIError"; data: { message: string; statusCode?: number; isRetryable: boolean; responseHeaders?: Record<string, string>; responseBody?: string } };

type BadRequestError = { data: unknown; errors: Array<Record<string, unknown>>; success: false };
type NotFoundError = { name: "NotFoundError"; data: { message: string } };
```

### `FileDiff`

```typescript
type FileDiff = { file: string; before: string; after: string; additions: number; deletions: number };
```

### `Todo`

```typescript
type Todo = { id: string; content: string; status: string; priority: string };
```

### `Path` — filesystem path info

```typescript
type Path = {
  state: string;      // where OpenCode stores session data (e.g. ~/.local/share/opencode)
  config: string;     // config directory
  worktree: string;   // current worktree path
  directory: string;  // current project directory
};
// Retrieve with: const paths = await client.path.get();
```

### `Project`

```typescript
type Project = {
  id: string;
  worktree: string;
  vcsDir?: string;
  vcs?: "git";
  time: { created: number; initialized?: number };
};
```

---

## `Config` type (opencode.json / OPENCODE_CONFIG_CONTENT)

```typescript
type Config = {
  $schema?: string;
  model?: string;                    // "provider/model-id"
  small_model?: string;              // for lightweight tasks like title generation
  theme?: string;
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  username?: string;

  // Instruction files to include (relative to project root or absolute paths)
  instructions?: Array<string>;

  // Permission rules
  permission?: {
    edit?: "ask" | "allow" | "deny";
    bash?: ("ask" | "allow" | "deny") | { [pattern: string]: "ask" | "allow" | "deny" };
    webfetch?: "ask" | "allow" | "deny";
    doom_loop?: "ask" | "allow" | "deny";
    external_directory?: "ask" | "allow" | "deny";
  };

  // MCP servers
  mcp?: {
    [name: string]: McpLocalConfig | McpRemoteConfig;
  };

  // Provider configuration and overrides
  provider?: { [providerID: string]: ProviderConfig };
  enabled_providers?: Array<string>;   // whitelist — only these providers
  disabled_providers?: Array<string>;  // blacklist

  // Agent configuration
  agent?: {
    plan?: AgentConfig;
    build?: AgentConfig;
    general?: AgentConfig;
    explore?: AgentConfig;
    [name: string]: AgentConfig | undefined;  // custom agents
  };

  // Tool enable/disable overrides
  tools?: { [toolName: string]: boolean };

  // Custom slash commands
  command?: {
    [name: string]: { template: string; description?: string; agent?: string; model?: string; subtask?: boolean };
  };

  // LSP servers
  lsp?: false | { [name: string]: { command: Array<string>; extensions?: Array<string>; disabled?: boolean; env?: Record<string, string>; initialization?: Record<string, unknown> } | { disabled: true } };

  // Code formatters
  formatter?: false | { [name: string]: { disabled?: boolean; command?: Array<string>; environment?: Record<string, string>; extensions?: Array<string> } };

  // Sharing
  share?: "manual" | "auto" | "disabled";
  autoupdate?: boolean | "notify";
  snapshot?: boolean;

  // TUI settings
  tui?: {
    scroll_speed?: number;
    scroll_acceleration?: { enabled: boolean };
    diff_style?: "auto" | "stacked";
  };

  // Plugins (npm package IDs)
  plugin?: Array<string>;

  // File watcher ignore patterns
  watcher?: { ignore?: Array<string> };

  // Enterprise
  enterprise?: { url?: string };

  // Experimental features
  experimental?: {
    hook?: {
      file_edited?: { [pattern: string]: Array<{ command: Array<string>; environment?: Record<string, string> }> };
      session_completed?: Array<{ command: Array<string>; environment?: Record<string, string> }>;
    };
    chatMaxRetries?: number;
    disable_paste_summary?: boolean;
    batch_tool?: boolean;
    openTelemetry?: boolean;
    primary_tools?: Array<string>;
  };

  keybinds?: KeybindsConfig;
  layout?: "auto" | "stretch";  // deprecated: always stretch
};
```

### `McpLocalConfig`

```typescript
type McpLocalConfig = {
  type: "local";
  command: Array<string>;
  environment?: { [key: string]: string };
  enabled?: boolean;
  timeout?: number;   // ms for tool fetch, default 5000
};
```

### `McpRemoteConfig`

```typescript
type McpRemoteConfig = {
  type: "remote";
  url: string;
  enabled?: boolean;
  headers?: { [key: string]: string };
  oauth?: McpOAuthConfig | false;   // false = disable OAuth auto-detection
  timeout?: number;
};
```

### `AgentConfig`

```typescript
type AgentConfig = {
  model?: string;
  temperature?: number;
  top_p?: number;
  prompt?: string;
  tools?: { [toolName: string]: boolean };
  disable?: boolean;
  description?: string;
  mode?: "subagent" | "primary" | "all";
  color?: string;                    // hex color for TUI display
  maxSteps?: number;                 // max agentic iterations before forcing text-only
  permission?: { /* same as Config.permission */ };
};
```

### `ProviderConfig`

```typescript
type ProviderConfig = {
  api?: string;
  name?: string;
  env?: Array<string>;
  id?: string;
  npm?: string;
  options?: {
    apiKey?: string;
    baseURL?: string;
    enterpriseUrl?: string;     // GitHub Enterprise for Copilot
    setCacheKey?: boolean;      // enable promptCacheKey
    timeout?: number | false;   // request timeout, default 300000 (5 min)
  };
  models?: { [modelID: string]: { /* model overrides */ } };
  whitelist?: Array<string>;
  blacklist?: Array<string>;
};
```

---

## Session storage and persistence

OpenCode stores session data in the `state` directory reported by `client.path.get()`.
This is typically an XDG state path: `~/.local/share/opencode` on Linux, or a platform
equivalent. It is NOT relative to `OPENCODE_PROJECT`.

**For session persistence across container restarts:**
- The state directory must be mounted from the host (add a volume mount for it)
- Retrieve the path via `client.path.get()` to confirm the actual location in the container
- After mounting, `session.list()` will return sessions from previous container invocations
- Use `session.get({ path: { id } })` to verify a stored session ID still exists (returns 404 if not)
- If valid, send the next prompt to the existing session ID via `session.prompt()`
- If 404, create a new session with `session.create()`

**Finding existing sessions for a group directory:**
```typescript
const result = await client.session.list({ query: { directory: '/workspace/group' } });
const existing = result.data?.find(s => s.title === `nanoclaw-${groupFolder}`);
```

---

## Other client APIs (brief)

### `client.path.get()` — get filesystem paths

```typescript
const result = await client.path.get();
// result.data: { state: string, config: string, worktree: string, directory: string }
```

### `client.config.get()` / `client.config.update()` — runtime config

```typescript
await client.config.get();            // → Config
await client.config.update({ body: partialConfig });  // → Config
await client.config.providers();      // → provider + model list
```

### `client.file.list()` / `.read()` / `.status()`

```typescript
await client.file.list({ path: { path: '/workspace/group' } });  // → Array<FileNode>
await client.file.read({ path: { path: '/workspace/group/foo.ts' } });  // → FileContent
await client.file.status();   // → git-status-like info
```

### `client.find.text()` / `.files()` / `.symbols()`

Text search, file glob, and workspace symbol search.

### `client.mcp.status()` / `.add()` / `.connect()` / `.disconnect()`

Runtime MCP server management.

### `client.instance.dispose()` — shut down server from client side

```typescript
await client.instance.dispose();
// → boolean; triggers "server.instance.disposed" event
```

### `client.app.log()` — write to server logs

```typescript
await client.app.log({ body: { level: 'info', message: 'hello' } });
```

### `client.app.agents()` — list configured agents

```typescript
const result = await client.app.agents();
// result.data: Array<Agent>
```

### `client.vcs.get()` — get current VCS branch

```typescript
const result = await client.vcs.get();
// result.data: { branch: string }
```

### `client.project.list()` / `client.project.current()`

```typescript
const result = await client.project.current();
// result.data: { id, worktree, vcsDir?, vcs?, time }
```

---

## V2 API

Import from `@opencode-ai/sdk/v2`. Same overall shape with additions:

- **`Session`** gains: `slug: string`, `time.archived?: number`, `permission?: PermissionRuleset`
- **`SessionCreate`** body gains: `permission?: PermissionRuleset`
- **`SessionList`** query gains: `roots?: boolean`, `start?: number`, `search?: string`, `limit?: number`
- **`SessionUpdate`** body gains: `time?: { archived?: number }`; path uses `sessionID` instead of `id`
- **`AssistantMessage`** gains: `agent?: string`, `tokens.total?: number`, `structured?: unknown`, `variant?: string`, `format?: OutputFormat`
- **`UserMessage`** gains: `variant?: string`, `format?: OutputFormat`
- **`Part`** gains: `SubtaskPart` as distinct named type
- **`Config`** gains: `compaction?: { auto?: boolean; prune?: boolean; reserved?: number }`; `experimental` gains `continue_loop_on_deny?: boolean`, `mcp_timeout?: number`
- **Events** gain: `message.part.delta`, `permission.asked`, `worktree.ready`, `worktree.failed`, `mcp.tools.changed`, `mcp.browser.open.failed`

---

## Nanoclaw-specific usage patterns

### Event loop with SSE fallback

```typescript
const { stream } = await client.event.subscribe();
let lastAssistantText = '';

const eventProcessor = (async () => {
  try {
    for await (const event of stream) {
      const evt = event as { type?: string; properties?: Record<string, unknown> };
      if (evt.type === 'message.part.updated') {
        const part = (evt.properties?.part) as { type: string; text?: string } | undefined;
        if (part?.type === 'text' && part.text) {
          lastAssistantText = part.text;  // overwrite (not append) — always full accumulated text
        }
      }
    }
  } catch { /* stream ended */ }
})();
```

### Casting events from SSE stream

The SDK uses a discriminated union internally, but arrives as `unknown` at runtime.
Cast with:
```typescript
const evt = event as { type?: string; properties?: Record<string, unknown> };
if (evt.type === 'session.idle') {
  const { sessionID } = evt.properties as { sessionID: string };
}
```

### Session persistence pattern

```typescript
// On container start, if containerInput.sessionId is set:
let sessionId: string;
if (containerInput.sessionId) {
  const check = await client.session.get({ path: { id: containerInput.sessionId } });
  if (check.error) {
    // Session not found — create new
    const created = await client.session.create({ body: { title: `nanoclaw-${groupFolder}` } });
    sessionId = created.data!.id;
  } else {
    sessionId = containerInput.sessionId;  // reuse existing
  }
} else {
  const created = await client.session.create({ body: { title: `nanoclaw-${groupFolder}` } });
  sessionId = created.data!.id;
}
```
