// The CLI side of the multi-session server: `difit serve`, `difit stop`, and
// `difit --pr <url>` adding the PR to the running server.
import { setTimeout as sleep } from 'timers/promises';

import { Command } from 'commander';
import open from 'open';

import pkg from '../../package.json' with { type: 'json' };
import { type PullRequestSource, startMultiServer } from '../server/multi-server.js';
import { type CommentImport } from '../types/diff.js';

import {
  BACKGROUND_CHILD_ENV,
  emitBackgroundHandshake,
  ignoreStdioErrorsForBackgroundDaemon,
  spawnBackgroundChild,
} from './background.js';
import { getPrCommentImports, getPrPatch, getPrTitle } from './github.js';
import {
  answersAsServer,
  claimServerState,
  findServer,
  releaseServerState,
  removeStaleServerState,
  serverBaseUrl,
  type ServerState,
} from './server-state.js';

interface ListenOptions {
  port?: number;
  host?: string;
}

const STOP_TIMEOUT_MS = 10_000;
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const github: PullRequestSource = { getPrPatch, getPrCommentImports, getPrTitle };

const alreadyRunning = (state: ServerState) =>
  new Error(
    `A difit server is already running on ${serverBaseUrl(state)} (pid ${state.pid}). Stop it with: difit stop`,
  );

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The arguments a detached `difit serve` child gets.
function serveArgs({ port, host }: ListenOptions): string[] {
  return [
    'serve',
    '--no-open',
    ...(port === undefined ? [] : ['--port', String(port)]),
    ...(host ? ['--host', host] : []),
  ];
}

async function openInBrowser(url: string): Promise<void> {
  try {
    await open(url);
  } catch {
    console.warn('Failed to open browser automatically');
  }
}

async function serve({ port, host = 'localhost' }: ListenOptions): Promise<ServerState> {
  const found = await findServer();
  if (found.kind === 'running') {
    throw alreadyRunning(found.state);
  }
  if (found.kind === 'stale') {
    removeStaleServerState(found.raw);
  }

  const { port: listeningPort, server } = await startMultiServer({
    github,
    preferredPort: port,
    host,
  });
  const state: ServerState = {
    host,
    port: listeningPort,
    pid: process.pid,
    version: pkg.version,
    startedAt: new Date().toISOString(),
  };
  if (!(await claimServerState(state))) {
    server.close();
    const winner = await findServer();
    throw winner.kind === 'running'
      ? alreadyRunning(winner.state)
      : new Error('Another difit server claimed the state file at the same time');
  }

  let stopping = false;
  const shutDown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    releaseServerState(state);
    server.closeAllConnections();
    server.close();
    process.exit(0);
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, shutDown);
  }
  return state;
}

export function createServeCommand(): Command {
  return new Command('serve')
    .description('Start a resident difit server that reviews each GitHub PR at /s/<id>/')
    .option('--port <port>', 'preferred port (auto-assigned if occupied)', (value) =>
      parseInt(value, 10),
    )
    .option('--host <host>', 'host address to bind: localhost or 127.0.0.1')
    .option('--no-open', 'do not open the list of PRs in the browser')
    .option('--background', 'start the server detached and print its JSON info once it is ready')
    .action(async (opts: ListenOptions & { open: boolean; background?: boolean }) => {
      try {
        if (opts.background) {
          console.log(JSON.stringify(await spawnBackgroundChild(serveArgs(opts))));
          return;
        }
        const state = await serve(opts);
        const url = serverBaseUrl(state);
        if (process.env[BACKGROUND_CHILD_ENV] === '1') {
          emitBackgroundHandshake({ port: state.port, url, pid: state.pid });
          ignoreStdioErrorsForBackgroundDaemon();
          return;
        }
        console.log(`\n🚀 difit server started on ${url}`);
        console.log('🗂️  Add pull requests with: difit --pr <url>');
        console.log('\nStop it with difit stop or Ctrl+C');
        if (opts.open) {
          await openInBrowser(url);
        }
      } catch (error) {
        console.error(`Error: ${describeError(error)}`);
        process.exit(1);
      }
    });
}

async function stopServer(): Promise<void> {
  const found = await findServer();
  switch (found.kind) {
    case 'none':
      console.log('No difit server is running');
      return;
    case 'stale':
      // The recorded process is gone or is not difit, so it gets no signal.
      removeStaleServerState(found.raw);
      console.log(`No difit server is running; removed a stale state file (${found.reason})`);
      return;
    case 'running': {
      const { state } = found;
      process.kill(state.pid, 'SIGTERM');
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (await answersAsServer(state)) {
        if (Date.now() > deadline) {
          throw new Error(`The difit server (pid ${state.pid}) did not stop within 10 seconds`);
        }
        await sleep(100);
      }
      releaseServerState(state);
      console.log(`Stopped the difit server on ${serverBaseUrl(state)} (pid ${state.pid})`);
      return;
    }
    default: {
      const _exhaustive: never = found;
      return _exhaustive;
    }
  }
}

export function createStopCommand(): Command {
  return new Command('stop')
    .description('Stop the server started by difit serve')
    .action(async () => {
      try {
        await stopServer();
      } catch (error) {
        console.error(`Error: ${describeError(error)}`);
        process.exit(1);
      }
    });
}

// Finds the running server, or starts one detached. When another difit --pr starts one
// at the same moment, this start fails and the other's server is used.
async function ensureServer(
  listen: ListenOptions,
): Promise<{ state: ServerState; started: boolean }> {
  const found = await findServer();
  if (found.kind === 'running') {
    return { state: found.state, started: false };
  }
  let startError: unknown;
  try {
    await spawnBackgroundChild(serveArgs(listen));
  } catch (error) {
    startError = error;
  }
  const after = await findServer();
  if (after.kind === 'running') {
    return { state: after.state, started: startError === undefined };
  }
  throw startError ?? new Error('The difit server started, but its state file is missing');
}

function parseSessionResponse(body: unknown): { url: string; label: string } | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { url, label } = body as Record<string, unknown>;
  return typeof url === 'string' && typeof label === 'string' ? { url, label } : null;
}

const errorOf = (body: unknown) =>
  typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
    ? body.error
    : undefined;

/** `difit --pr <url>`: adds the PR to the running server, starting one if needed. */
export async function reviewOnServer(options: {
  prUrl: string;
  commentImports: CommentImport[];
  clean: boolean;
  open: boolean;
  json: boolean;
  listen: ListenOptions;
}): Promise<void> {
  const { state, started } = await ensureServer(options.listen);
  const base = serverBaseUrl(state);
  const response = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prUrl: options.prUrl,
      commentImports: options.commentImports,
      clean: options.clean,
    }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  const session = parseSessionResponse(body);
  if (!response.ok || !session) {
    throw new Error(errorOf(body) ?? `The difit server answered ${response.status}`);
  }
  const pageUrl = `${base}${session.url}`;

  if (options.json) {
    console.log(JSON.stringify({ port: state.port, url: pageUrl, pid: state.pid }));
    return;
  }
  if (started) {
    console.log(`\n🚀 Started a difit server on ${base} (stop it with: difit stop)`);
  }
  console.log(`📋 Reviewing ${session.label}: ${pageUrl}`);
  if (options.open) {
    console.log('🌐 Opening browser...');
    await openInBrowser(pageUrl);
  }
}
