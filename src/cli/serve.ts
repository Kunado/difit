// The CLI side of the multi-session server: `difit serve`, `difit stop`, and
// `difit --pr <url>` adding the PR to the running server.
import { resolve } from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { Command } from 'commander';
import open from 'open';

import pkg from '../../package.json' with { type: 'json' };
import { type PullRequestSource, startMultiServer } from '../server/multi-server.js';
import { defaultPrListPath, openPrList } from '../server/pr-list.js';
import { sessionIdForPullRequest } from '../server/pull-request-url.js';
import { type CommentImport } from '../types/diff.js';

import {
  BACKGROUND_CHILD_ENV,
  emitBackgroundHandshake,
  ignoreStdioErrorsForBackgroundDaemon,
  spawnBackgroundChild,
} from './background.js';
import { getPrCommentImports, getPrPatch, getPrSummary } from './github.js';
import {
  claimServerState,
  findServer,
  notAnswering,
  probeServer,
  releaseServerState,
  removeStaleServerState,
  serverBaseUrl,
  type ServerState,
} from './server-state.js';

interface ListenOptions {
  port?: number;
  host?: string;
}

interface ServeOptions extends ListenOptions {
  /** Absolute path of the PR list; the default list when absent. */
  prs?: string;
}

const STOP_TIMEOUT_MS = 10_000;
const SHUTDOWN_FLUSH_TIMEOUT_MS = 3_000;
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
// A PR as a browser shows it: https://<host>/<owner>/<repo>/pull/<number>, optionally
// followed by a page under it (/files), a trailing slash, a query, or a fragment.
const PR_PAGE_PATTERN = /^https:\/\/([^/?#]+)(\/[^/?#]+\/[^/?#]+\/pull\/[^/?#]+)(?:[/?#].*)?$/s;
const PR_URL_ERROR = '--pr must be a URL like https://github.com/<owner>/<repo>/pull/<number>';

const github: PullRequestSource = { getPrPatch, getPrCommentImports, getPrSummary };

const alreadyRunning = (state: ServerState) =>
  new Error(
    `A difit server is already running on ${serverBaseUrl(state)} (pid ${state.pid}). Stop it with: difit stop`,
  );

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Reduces a PR URL to the https://github.com/<owner>/<repo>/pull/<number> the running
 * server accepts, so every form of one PR reaches one session. Throws for anything else.
 */
export function resolvePullRequestUrl(input: string): { url: string; sessionId: string } {
  const [, host, path] = PR_PAGE_PATTERN.exec(input) ?? [];
  if (host === undefined || path === undefined) {
    throw new Error(PR_URL_ERROR);
  }
  if (host.toLowerCase() !== 'github.com') {
    throw new Error(
      `${host} is not github.com. The difit server reviews github.com PRs only; for GitHub Enterprise, use difit --pr <url> --standalone`,
    );
  }
  const url = `https://github.com${path}`;
  const sessionId = sessionIdForPullRequest(url);
  if (sessionId === null) {
    throw new Error(PR_URL_ERROR);
  }
  return { url, sessionId };
}

// The arguments a detached `difit serve` child gets.
function serveArgs({ port, host, prs }: ServeOptions): string[] {
  return [
    'serve',
    '--no-open',
    ...(port === undefined ? [] : ['--port', String(port)]),
    ...(host ? ['--host', host] : []),
    ...(prs === undefined ? [] : ['--prs', prs]),
  ];
}

async function openInBrowser(url: string): Promise<void> {
  try {
    await open(url);
  } catch {
    console.warn('Failed to open browser automatically');
  }
}

async function serve({
  port,
  host = 'localhost',
  prs = defaultPrListPath(),
}: ServeOptions): Promise<ServerState> {
  const found = await findServer();
  if (found.kind === 'running') {
    throw alreadyRunning(found.state);
  }
  if (found.kind === 'unresponsive') {
    throw notAnswering(found.state);
  }
  if (found.kind === 'stale') {
    removeStaleServerState(found.raw);
  }

  const prList = await openPrList(prs);
  const warning = prList.warning();
  if (warning) {
    console.warn(`Warning: ${warning}`);
  }
  const {
    port: listeningPort,
    server,
    restoreSessions,
  } = await startMultiServer({
    github,
    prList,
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
  // Only the server holding the state file restores, since restoring rewrites the list.
  // It runs in the background: the server already answers, and lists each saved PR as
  // restoring until its turn.
  void restoreSessions();

  let stopping = false;
  const shutDown = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    // Stop accepting new requests first
    server.closeAllConnections();
    server.close();
    // Wait for in-flight and queued saves to complete, up to the timeout
    const completed = await prList.flush(SHUTDOWN_FLUSH_TIMEOUT_MS);
    if (!completed) {
      // The flush timed out. Remove our own temp file; any in-flight save will fail to
      // rename, but prs.json remains valid JSON (the save wrote to the temp file, not to it).
      await prList.discardTempFile();
    }
    releaseServerState(state);
    process.exit(0);
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => void shutDown());
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
    .option(
      '--prs <path>',
      'JSON file that keeps the open PRs across restarts (default: ~/.difit/prs.json)',
    )
    .action(async (opts: ServeOptions & { open: boolean; background?: boolean }) => {
      try {
        // Resolved here, so a background child, which may run elsewhere, gets the same file.
        const options = { ...opts, prs: opts.prs === undefined ? undefined : resolve(opts.prs) };
        if (opts.background) {
          console.log(JSON.stringify(await spawnBackgroundChild(serveArgs(options))));
          return;
        }
        const state = await serve(options);
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
    case 'unresponsive':
      // Possibly a busy difit server; without its answer the pid gets no signal.
      throw notAnswering(found.state);
    case 'running': {
      const { state } = found;
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch (error) {
        // ESRCH: it exited after the check, which is the outcome asked for.
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          throw error;
        }
      }
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (['this-server', 'no-answer'].includes(await probeServer(state))) {
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
  if (found.kind === 'unresponsive') {
    throw notAnswering(found.state);
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
  // Before ensureServer, so a refused URL starts no server.
  const { url: prUrl } = resolvePullRequestUrl(options.prUrl);
  const { state, started } = await ensureServer(options.listen);
  const base = serverBaseUrl(state);
  const response = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prUrl,
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
