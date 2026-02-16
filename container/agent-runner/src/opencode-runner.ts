/**
 * OpenCode Agent Runner
 * Alternative runtime that uses OpenCode instead of Claude Code SDK.
 * Same stdin/stdout protocol and IPC mechanism as the Claude runner.
 */

import fs from 'fs';
import path from 'path';
import { createOpencode } from '@opencode-ai/sdk';

export interface ContainerInput {
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

  // Resolve API key from secrets (only if explicitly configured)
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
    // Load CLAUDE.md and any additional instruction files
    instructions: ['CLAUDE.md'],
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

    // Set up SSE event stream for real-time updates
    const eventResult = await client.event.subscribe();
    const eventStream = eventResult.stream;
    let lastAssistantText = '';

    // Process events in background
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
        const response = await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: 'text' as const, text: prompt }],
          },
        });

        // Extract result from response
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
      }

      // Check for close before waiting
      if (shouldClose()) {
        log('Close sentinel received after query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

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
