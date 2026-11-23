import { Command, Option } from 'commander';

import { parseCommentImportValue } from '../utils/commentImports.js';
import { SESSION_ID_LENGTH } from '../utils/sessionPath.js';

import { resolvePullRequestUrl } from './serve.js';
import { findServer, notAnswering, serverBaseUrl } from './server-state.js';
import { detectStdinSource, readStdin } from './utils.js';

interface CommentImportResponse {
  success?: boolean;
  importId?: string;
  count?: number;
  warnings?: string[];
}

/** Which server, and which of its sessions, a comment command talks to. */
interface ServerOptions {
  port?: number;
  session?: string;
  pr?: string;
}

const SESSION_ID_PATTERN = new RegExp(`^[0-9a-f]{${SESSION_ID_LENGTH}}$`);

const portOption = () =>
  new Option('--port <port>', 'port of the running difit server').argParser(parseInt);
const sessionOption = () =>
  new Option('--session <id>', 'session on the server from difit serve (the <id> in /s/<id>/)');
const prOption = () =>
  new Option('--pr <url>', "GitHub PR URL; uses that PR's session on the server from difit serve");

function sessionIdOf({ session, pr }: ServerOptions): string | undefined {
  if (session !== undefined && pr !== undefined) {
    throw new Error('Use either --session or --pr, not both');
  }
  if (session !== undefined) {
    if (!SESSION_ID_PATTERN.test(session)) {
      throw new Error(`--session must be the ${SESSION_ID_LENGTH}-character hex id in /s/<id>/`);
    }
    return session;
  }
  if (pr !== undefined) {
    return resolvePullRequestUrl(pr).sessionId;
  }
  return undefined;
}

// --port alone keeps the single-server API at the root. A session adds /s/<id>, on the
// server in --port or else the one the state file names.
async function resolveApiBase(opts: ServerOptions): Promise<string> {
  const sessionId = sessionIdOf(opts);
  let origin: string;
  if (opts.port !== undefined) {
    origin = `http://localhost:${opts.port}`;
  } else if (sessionId !== undefined) {
    const found = await findServer();
    if (found.kind === 'unresponsive') {
      throw notAnswering(found.state);
    }
    if (found.kind !== 'running') {
      throw new Error('No difit server is running. Start one with difit serve, or pass --port');
    }
    origin = serverBaseUrl(found.state);
  } else {
    throw new Error('Pass --port, or --session or --pr for a session on the running difit server');
  }
  return sessionId === undefined ? origin : `${origin}/s/${sessionId}`;
}

function handleCommandError(error: unknown, base: string | undefined): never {
  if (error instanceof TypeError && error.message.includes('fetch failed')) {
    console.error(`Error: Cannot connect to the difit server at ${base}. Is the server running?`);
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  process.exit(1);
}

async function parseCommentAddInput(json?: string): Promise<string> {
  if (typeof json === 'string') {
    return json;
  }

  if (detectStdinSource() === 'tty') {
    throw new Error('Provide comment JSON as an argument or via stdin');
  }

  const stdin = await readStdin();
  if (!stdin.trim()) {
    throw new Error('No comment JSON received from stdin');
  }

  return stdin;
}

export function createCommentCommand(): Command {
  const comment = new Command('comment').description(
    'Add, retrieve, or resolve comments on a running difit server',
  );

  comment
    .command('add')
    .description('Add comments to a running difit server')
    .argument('[json]', 'comment import JSON (object or array)')
    .addOption(portOption())
    .addOption(sessionOption())
    .addOption(prOption())
    .action(async (json: string | undefined, opts: ServerOptions) => {
      let base: string | undefined;
      try {
        base = await resolveApiBase(opts);
        const input = await parseCommentAddInput(json);
        const imports = parseCommentImportValue(input);

        const response = await fetch(`${base}/api/comment-imports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(imports),
        });

        if (!response.ok) {
          const errorBody = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          console.error(`Error: ${errorBody.error ?? 'Failed to add comments'}`);
          process.exit(1);
        }

        const result = (await response.json()) as CommentImportResponse;
        console.log(
          JSON.stringify({
            success: result.success ?? true,
            importId: result.importId,
            count: result.count ?? imports.length,
            warnings: result.warnings ?? [],
          }),
        );
      } catch (error) {
        handleCommandError(error, base);
      }
    });

  comment
    .command('get')
    .description('Retrieve comments from a running difit server')
    .addOption(portOption())
    .addOption(sessionOption())
    .addOption(prOption())
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .action(async (opts: ServerOptions & { format: string }) => {
      let base: string | undefined;
      try {
        base = await resolveApiBase(opts);
        const endpoint = opts.format === 'json' ? '/api/comments-json' : '/api/comments-output';
        const response = await fetch(`${base}${endpoint}`);

        if (!response.ok) {
          console.error('Error: Failed to retrieve comments');
          process.exit(1);
        }

        if (opts.format === 'json') {
          const data: unknown = await response.json();
          console.log(JSON.stringify(data));
        } else {
          const text = await response.text();
          if (text.trim()) {
            console.log(text);
          }
        }
      } catch (error) {
        handleCommandError(error, base);
      }
    });

  comment
    .command('resolve')
    .alias('remove')
    .description('Resolve (remove) comment threads on a running difit server')
    .argument('<threadIds...>', 'thread IDs to resolve')
    .addOption(portOption())
    .addOption(sessionOption())
    .addOption(prOption())
    .action(async (threadIds: string[], opts: ServerOptions) => {
      let base: string | undefined;
      try {
        base = await resolveApiBase(opts);
        const results = await Promise.all(
          threadIds.map(
            async (
              threadId,
            ): Promise<{
              threadId: string;
              status: 'resolved' | 'notFound' | 'error';
              error?: string;
            }> => {
              const response = await fetch(`${base}/api/comments/${encodeURIComponent(threadId)}`, {
                method: 'DELETE',
              });

              if (response.ok) {
                return { threadId, status: 'resolved' };
              }

              if (response.status === 404) {
                return { threadId, status: 'notFound' };
              }

              const errorBody = (await response.json().catch(() => ({}))) as {
                error?: string;
              };
              return {
                threadId,
                status: 'error',
                error: errorBody.error ?? `Failed to resolve thread ${threadId}`,
              };
            },
          ),
        );

        const resolved = results.filter((r) => r.status === 'resolved').map((r) => r.threadId);
        const notFound = results.filter((r) => r.status === 'notFound').map((r) => r.threadId);
        const errors = results
          .filter((r) => r.status === 'error')
          .map((r) => ({
            threadId: r.threadId,
            error: r.error ?? `Failed to resolve thread ${r.threadId}`,
          }));

        console.log(
          JSON.stringify({
            success: notFound.length === 0 && errors.length === 0,
            resolved,
            notFound,
            errors,
          }),
        );
        if (notFound.length > 0 || errors.length > 0) {
          process.exit(1);
        }
      } catch (error) {
        handleCommandError(error, base);
      }
    });

  return comment;
}
