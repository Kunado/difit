// Runs the real CLI entry point (index.ts) in-process: each runCli() sets process.argv,
// imports a fresh copy of index.ts, and waits for commander to finish. Servers listen on
// port 0, the state file lives in a temporary DIFIT_CONFIG_DIR, gh and the browser are
// fakes, and signals to this process are delivered to its listeners instead.
import { promises as fsPromises } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createServer, type Server } from 'http';
import { type AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { fetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../package.json' with { type: 'json' };
import { sessionIdForPullRequest } from '../server/pull-request-url.js';

const PR_A = 'https://github.com/octo/alpha/pull/1';
const PR_B = 'https://github.com/octo/beta/pull/2';
const PR_C = 'https://github.com/octo/gamma/pull/3';
// A pid above every platform's limit, so no process has it.
const DEAD_PID = 2_147_483_647;
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

const fakes = vi.hoisted(() => ({
  open: vi.fn(async (_url: string) => undefined),
  spawnBackgroundChild: vi.fn(),
  // What gh pr view reports as each PR's state; OPEN unless a test says otherwise.
  prStates: new Map<string, 'OPEN' | 'CLOSED' | 'MERGED'>(),
}));

// "https://github.com/octo/alpha/pull/1" -> "alpha.ts", so each PR has its own file.
const fileOf = (prUrl: string) => `${new URL(prUrl).pathname.split('/')[2]}.ts`;
const patchFor = (file: string) =>
  [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    '-old line',
    '+new line',
    '',
  ].join('\n');

vi.mock('./github.js', () => ({
  getPrPatch: async (prUrl: string) => patchFor(fileOf(prUrl)),
  getPrCommentImports: async () => [],
  getPrSummary: async (prUrl: string) => ({
    title: `Title of ${prUrl}`,
    state: fakes.prStates.get(prUrl) ?? 'OPEN',
  }),
}));
vi.mock('open', () => ({ default: fakes.open }));
vi.mock('./background.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./background.js')>()),
  spawnBackgroundChild: fakes.spawnBackgroundChild,
}));
// The single-session server would listen on 4966; tests that reach it say what it returns.
vi.mock('../server/server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/server.js')>()),
  startServer: vi.fn(async () => {
    throw new Error('startServer must not run unmocked in this test');
  }),
}));

const { startServer } = await import('../server/server.js');

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let configDir: string;
let output: { stdout: string[]; stderr: string[] };
let kills: Array<{ pid: number; signal: string | number | undefined }>;
const baselineListeners = new Map<string, Function[]>();
const otherServers: Server[] = [];
const realKill = process.kill.bind(process);
const originalArgv = process.argv;
const originalConfigDir = process.env.DIFIT_CONFIG_DIR;

const statePath = () => join(configDir, 'server.json');
const prsPath = () => join(configDir, 'prs.json');
async function savedUrls(path: string): Promise<string[]> {
  const file: { pullRequests: Array<{ url: string }> } = JSON.parse(await readFile(path, 'utf8'));
  return file.pullRequests.map((row) => row.url);
}
const readState = async () => JSON.parse(await readFile(statePath(), 'utf8')) as ServerState;

interface ServerState {
  host: string;
  port: number;
  pid: number;
  version: string;
  startedAt: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  const stdoutStart = output.stdout.length;
  const stderrStart = output.stderr.length;
  process.argv = [process.execPath, '/usr/local/bin/difit', ...args];
  vi.resetModules();
  let code = 0;
  try {
    const { cliCompletion } = await import('./index.js');
    await cliCompletion;
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
    code = error.code;
  } finally {
    process.argv = originalArgv;
  }
  return {
    code: code === 0 && typeof process.exitCode === 'number' ? process.exitCode : code,
    stdout: output.stdout.slice(stdoutStart).join('\n'),
    stderr: output.stderr.slice(stderrStart).join('\n'),
  };
}

// What the OS does on `kill -TERM <this pid>`: run the listeners this test's CLI added.
async function deliver(signal: (typeof SIGNALS)[number]): Promise<void> {
  const baseline = baselineListeners.get(signal) ?? [];
  for (const listener of process.listeners(signal)) {
    if (!baseline.includes(listener)) {
      const result = (listener as (signal: string) => void | Promise<void>)(signal);
      if (result instanceof Promise) {
        try {
          await result;
        } catch (error) {
          if (!(error instanceof ExitError)) {
            throw error;
          }
        }
      }
    }
  }
}

async function startOtherApp(): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: 'something-else' }));
  });
  otherServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

// Accepts requests and never answers, like a server whose event loop is stuck.
async function startUnresponsiveApp(): Promise<number> {
  const server = createServer(() => {});
  otherServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function writeState(state: Partial<ServerState>): Promise<void> {
  await writeFile(
    statePath(),
    JSON.stringify({
      host: '127.0.0.1',
      port: 1,
      pid: DEAD_PID,
      version: pkg.version,
      startedAt: '2026-01-01T00:00:00.000Z',
      ...state,
    }),
  );
}

async function serve(): Promise<{ base: string; state: ServerState }> {
  const result = await runCli(['serve', '--port', '0', '--no-open']);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  const state = await readState();
  return { base: `http://${state.host}:${state.port}`, state };
}

async function listSessions(base: string) {
  const response = await fetch(`${base}/api/sessions`);
  const body = (await response.json()) as {
    sessions: Array<{ id: string; url: string; prUrl: string; status: string }>;
  };
  return body.sessions;
}

// Waits until the server has restored its saved PRs, then reports each as [prUrl, status].
async function restoredSessions(base: string) {
  let sessions: Awaited<ReturnType<typeof listSessions>> = [];
  await vi.waitFor(async () => {
    sessions = await listSessions(base);
    expect(sessions.every((session) => session.status !== 'restoring')).toBe(true);
  });
  return sessions;
}

const comment = (id: string, body: string) =>
  JSON.stringify({
    type: 'thread',
    id,
    filePath: 'alpha.ts',
    position: { side: 'new', line: 1 },
    body,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'difit-cli-'));
  process.env.DIFIT_CONFIG_DIR = configDir;
  // vitest.setup.ts replaces fetch for component tests; the CLI runs on Node's fetch.
  vi.stubGlobal('fetch', fetch);
  process.exitCode = undefined;
  output = { stdout: [], stderr: [] };
  kills = [];
  for (const signal of SIGNALS) {
    baselineListeners.set(signal, process.listeners(signal));
  }

  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.stdout.push(args.join(' '));
  });
  for (const method of ['error', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.stderr.push(args.join(' '));
    });
  }
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitError(typeof code === 'number' ? code : 0);
  });
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal === undefined || signal === 0) {
      return realKill(pid, 0);
    }
    kills.push({ pid, signal });
    if (pid === process.pid && signal === 'SIGTERM') {
      void deliver('SIGTERM');
    }
    return true;
  });

  fakes.open.mockClear();
  fakes.prStates.clear();
  vi.mocked(startServer).mockClear();
  // Stands in for the detached `difit serve` child: runs the same command in-process.
  fakes.spawnBackgroundChild.mockReset();
  fakes.spawnBackgroundChild.mockImplementation(async (childArgs: string[]) => {
    const result = await runCli(childArgs);
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
    const state = await readState();
    return { port: state.port, url: `http://${state.host}:${state.port}`, pid: state.pid };
  });
});

afterEach(async () => {
  await deliver('SIGTERM');
  for (const signal of SIGNALS) {
    const baseline = baselineListeners.get(signal) ?? [];
    for (const listener of process.listeners(signal)) {
      if (!baseline.includes(listener)) {
        process.removeListener(signal, listener);
      }
    }
  }
  await Promise.all(
    otherServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  if (originalConfigDir === undefined) {
    delete process.env.DIFIT_CONFIG_DIR;
  } else {
    process.env.DIFIT_CONFIG_DIR = originalConfigDir;
  }
  await rm(configDir, { recursive: true, force: true });
});

describe('difit serve', () => {
  it('writes the state file once it listens and answers server-info', async () => {
    const result = await runCli(['serve', '--port', '0', '--no-open']);

    expect(result.code).toBe(0);
    const state = await readState();
    expect(state).toEqual({
      host: 'localhost',
      port: expect.any(Number),
      pid: process.pid,
      version: pkg.version,
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(state.port).toBeGreaterThan(0);
    expect(result.stdout).toContain(`🚀 difit server started on http://localhost:${state.port}`);
    const info = await (await fetch(`http://localhost:${state.port}/api/server-info`)).json();
    expect(info).toMatchObject({ app: 'difit', mode: 'multi', pid: process.pid });
    expect(fakes.open).not.toHaveBeenCalled();
  });

  it('refuses to start while another server holds the state file', async () => {
    const { state } = await serve();

    const second = await runCli(['serve', '--port', '0', '--no-open']);

    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/already running/);
    expect(await readState()).toEqual(state);
  });

  it('replaces a state file whose process is gone', async () => {
    await writeState({ pid: DEAD_PID });

    const { state } = await serve();

    expect(state.pid).toBe(process.pid);
  });

  it('keeps the state file of a live process whose port does not answer in time', async () => {
    const port = await startUnresponsiveApp();
    await writeState({ pid: process.pid, port });

    const result = await runCli(['serve', '--port', '0', '--no-open']);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not answering/);
    expect((await readState()).port).toBe(port);
  });

  it('replaces a state file whose port answers as another app', async () => {
    const otherPort = await startOtherApp();
    await writeState({ pid: process.pid, port: otherPort });

    const { state } = await serve();

    expect(state.port).not.toBe(otherPort);
    expect(kills).toEqual([]);
  });

  it('removes its state file and stops listening on SIGTERM', async () => {
    const { base } = await serve();

    await deliver('SIGTERM');

    await expect(readFile(statePath(), 'utf8')).rejects.toThrow(/ENOENT/);
    await expect(fetch(`${base}/api/server-info`)).rejects.toThrow();
  });

  it('keeps the port open and the state file until the pending save is flushed, then closes and exits', async () => {
    const { base } = await serve();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let saving = false;
    const realRename = fsPromises.rename.bind(fsPromises);
    // Holds the rename of prs.json, so the save stays in flight until the gate opens.
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (to === prsPath()) {
        saving = true;
        await gate;
      }
      return realRename(from, to);
    });
    const exit = vi.mocked(process.exit);
    let shutdown: Promise<void> | undefined;

    try {
      const adding = fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prUrl: PR_A, commentImports: [], clean: false }),
      }).catch(() => undefined);
      await vi.waitFor(() => expect(saving).toBe(true));

      shutdown = deliver('SIGTERM');

      // difit stop treats a refused port as "stopped", so the port must answer while saving.
      const info = await fetch(`${base}/api/server-info`);
      expect(info.status).toBe(200);
      expect(exit).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(statePath(), 'utf8'))).toMatchObject({ pid: process.pid });

      openGate();
      await shutdown;
      await adding;

      expect(exit).toHaveBeenCalledWith(0);
      await expect(readFile(statePath(), 'utf8')).rejects.toThrow(/ENOENT/);
      await expect(fetch(`${base}/api/server-info`)).rejects.toThrow();
      expect(await savedUrls(prsPath())).toEqual([PR_A]);
    } finally {
      // Let a failed run finish its shutdown while the mocks are still in place.
      openGate();
      await shutdown;
    }
  });

  it('starts in the background and prints the child handshake', async () => {
    const result = await runCli(['serve', '--background', '--port', '0']);

    expect(result.code).toBe(0);
    expect(fakes.spawnBackgroundChild).toHaveBeenCalledWith(['serve', '--no-open', '--port', '0']);
    const state = await readState();
    expect(result.stdout).toContain(
      JSON.stringify({ port: state.port, url: `http://localhost:${state.port}`, pid: state.pid }),
    );
  });
});

describe('difit stop', () => {
  it('stops the server named by the state file and server-info, then removes the file', async () => {
    const { base } = await serve();

    const result = await runCli(['stop']);

    expect(result.code).toBe(0);
    expect(kills).toEqual([{ pid: process.pid, signal: 'SIGTERM' }]);
    await expect(readFile(statePath(), 'utf8')).rejects.toThrow(/ENOENT/);
    await expect(fetch(`${base}/api/server-info`)).rejects.toThrow();
    expect(result.stdout).toMatch(/Stopped the difit server/);
  });

  it('clears a state file whose process is gone without sending a signal', async () => {
    await writeState({ pid: DEAD_PID });

    const result = await runCli(['stop']);

    expect(result.code).toBe(0);
    expect(kills).toEqual([]);
    await expect(readFile(statePath(), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('clears a state file whose port answers as another app without signalling its pid', async () => {
    const otherPort = await startOtherApp();
    await writeState({ pid: process.pid, port: otherPort });

    const result = await runCli(['stop']);

    expect(result.code).toBe(0);
    expect(kills).toEqual([]);
    await expect(readFile(statePath(), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('leaves a live process whose port does not answer in time alone', async () => {
    const port = await startUnresponsiveApp();
    await writeState({ pid: process.pid, port });

    const result = await runCli(['stop']);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not answering/);
    expect(kills).toEqual([]);
    expect((await readState()).port).toBe(port);
  });

  it('says so when no server is running', async () => {
    const result = await runCli(['stop']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No difit server is running/);
    expect(kills).toEqual([]);
  });
});

describe('difit --pr', () => {
  it('adds the PR to the running server and prints its page', async () => {
    const { base } = await serve();

    const result = await runCli(['--pr', PR_A, '--no-open']);

    expect(result.code).toBe(0);
    const sessions = await listSessions(base);
    expect(sessions).toEqual([expect.objectContaining({ prUrl: PR_A })]);
    expect(result.stdout).toContain(`${base}${sessions[0]?.url}`);
    expect(fakes.open).not.toHaveBeenCalled();
    expect(fakes.spawnBackgroundChild).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
  });

  it('adds a second PR to the same server', async () => {
    const { base, state } = await serve();

    await runCli(['--pr', PR_A, '--no-open']);
    const second = await runCli(['--pr', PR_B, '--no-open']);

    expect(second.code).toBe(0);
    expect((await listSessions(base)).map((session) => session.prUrl)).toEqual([PR_A, PR_B]);
    expect(await readState()).toEqual(state);
  });

  it('passes --comment and --clean to the new session', async () => {
    const { base } = await serve();

    const result = await runCli([
      '--pr',
      PR_A,
      '--no-open',
      '--clean',
      '--comment',
      comment('c1', 'from the CLI'),
    ]);

    expect(result.code).toBe(0);
    const [session] = await listSessions(base);
    const comments = await (await fetch(`${base}${session?.url}api/comments-json`)).json();
    expect(JSON.stringify(comments)).toContain('from the CLI');
    const diff = (await (await fetch(`${base}${session?.url}api/diff`)).json()) as {
      clearComments?: boolean;
    };
    expect(diff.clearComments).toBe(true);
  });

  it('starts a background server when none is running, then adds the PR', async () => {
    const result = await runCli(['--pr', PR_A, '--no-open', '--port', '0']);

    expect(result.code).toBe(0);
    expect(fakes.spawnBackgroundChild).toHaveBeenCalledWith(['serve', '--no-open', '--port', '0']);
    const state = await readState();
    const base = `http://${state.host}:${state.port}`;
    const sessions = await listSessions(base);
    expect(sessions).toEqual([expect.objectContaining({ prUrl: PR_A })]);
    expect(result.stdout).toContain(`${base}${sessions[0]?.url}`);
    // The server it starts saves to the default list.
    expect(await savedUrls(prsPath())).toEqual([PR_A]);
  });

  it('opens the PR page in the browser unless --no-open', async () => {
    const { base } = await serve();

    await runCli(['--pr', PR_A]);

    const [session] = await listSessions(base);
    expect(fakes.open).toHaveBeenCalledWith(`${base}${session?.url}`);
  });

  it('prints the page as JSON with --background', async () => {
    const { base, state } = await serve();

    const result = await runCli(['--pr', PR_A, '--background']);

    const [session] = await listSessions(base);
    expect(result.stdout).toContain(
      JSON.stringify({ port: state.port, url: `${base}${session?.url}`, pid: state.pid }),
    );
    expect(fakes.open).not.toHaveBeenCalled();
  });

  it('adds the pages, trailing slash, query, and fragment of one PR to one session', async () => {
    const { base } = await serve();
    const variants = [PR_A, `${PR_A}/`, `${PR_A}/files`, `${PR_A}/commits/`, `${PR_A}?x=1#y`];

    const results = [];
    for (const url of variants) {
      results.push(await runCli(['--pr', url, '--no-open']));
    }

    const sessions = await listSessions(base);
    expect(sessions).toEqual([expect.objectContaining({ prUrl: PR_A })]);
    for (const result of results) {
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`${base}${sessions[0]?.url}`);
    }
  });

  it('rejects an invalid PR URL without starting a server', async () => {
    const result = await runCli(['--pr', 'https://example.com/not-a-pr', '--no-open']);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--pr must be a URL like https:\/\/github\.com\//);
    expect(fakes.spawnBackgroundChild).not.toHaveBeenCalled();
    await expect(readFile(statePath(), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('rejects a GitHub Enterprise PR without starting a server and points to --standalone', async () => {
    const result = await runCli([
      '--pr',
      'https://ghe.example.internal/acme/widgets/pull/12',
      '--no-open',
      '--port',
      '0',
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ghe.example.internal');
    expect(result.stderr).toContain('--standalone');
    expect(fakes.spawnBackgroundChild).not.toHaveBeenCalled();
    await expect(readFile(statePath(), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('keeps the single-server --pr with --standalone', async () => {
    vi.mocked(startServer).mockResolvedValueOnce({
      port: 4966,
      url: 'http://localhost:4966',
      isEmpty: false,
    });

    const result = await runCli(['--pr', PR_A, '--standalone', '--no-open']);

    expect(result.code).toBe(0);
    expect(startServer).toHaveBeenCalledWith(
      expect.objectContaining({ stdinDiff: patchFor('alpha.ts'), openBrowser: false }),
    );
    expect(result.stdout).toContain('🚀 difit server started on http://localhost:4966');
    expect(result.stdout).toContain(`📋 Reviewing: ${PR_A}`);
    expect(fakes.spawnBackgroundChild).not.toHaveBeenCalled();
    await expect(readFile(statePath(), 'utf8')).rejects.toThrow(/ENOENT/);
    await expect(readFile(prsPath(), 'utf8')).rejects.toThrow(/ENOENT/);
  });
});

describe('single-server mode', () => {
  it('prints the unchanged start line for a local diff', async () => {
    vi.mocked(startServer).mockResolvedValueOnce({
      port: 4966,
      url: 'http://localhost:4966',
      isEmpty: false,
    });

    const result = await runCli(['HEAD', '--no-open']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('🚀 difit server started on http://localhost:4966');
    expect(result.stdout).toContain('📋 Reviewing: HEAD');
    expect(fakes.spawnBackgroundChild).not.toHaveBeenCalled();
    await expect(readFile(prsPath(), 'utf8')).rejects.toThrow(/ENOENT/);
  });
});

describe('the saved PR list', () => {
  it('reopens the PRs it had open after difit stop and difit serve', async () => {
    await serve();
    await runCli(['--pr', PR_A, '--no-open']);
    await runCli(['--pr', PR_B, '--no-open']);
    expect((await runCli(['stop'])).code).toBe(0);

    const { base } = await serve();

    const sessions = await restoredSessions(base);
    expect(sessions.map((session) => [session.prUrl, session.status])).toEqual([
      [PR_A, 'open'],
      [PR_B, 'open'],
    ]);
    for (const session of sessions) {
      expect((await fetch(`${base}${session.url}api/diff`)).status).toBe(200);
    }
  });

  it('forgets a PR closed in the list, also after a restart', async () => {
    const { base } = await serve();
    await runCli(['--pr', PR_A, '--no-open']);
    await runCli(['--pr', PR_B, '--no-open']);
    const [a] = await listSessions(base);

    const close = await fetch(`${base}/api/sessions/${a?.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(close.status).toBe(200);
    expect(await savedUrls(prsPath())).toEqual([PR_B]);
    await runCli(['stop']);
    const { base: next } = await serve();
    expect((await restoredSessions(next)).map((session) => session.prUrl)).toEqual([PR_B]);
  });

  it('drops PRs merged or closed while it was stopped', async () => {
    await serve();
    for (const prUrl of [PR_A, PR_B, PR_C]) {
      await runCli(['--pr', prUrl, '--no-open']);
    }
    await runCli(['stop']);
    fakes.prStates.set(PR_B, 'MERGED');
    fakes.prStates.set(PR_C, 'CLOSED');

    const { base } = await serve();

    expect((await restoredSessions(base)).map((session) => session.prUrl)).toEqual([PR_A]);
    // The list drops a PR at once and writes the file right after.
    await vi.waitFor(async () => expect(await savedUrls(prsPath())).toEqual([PR_A]));
  });

  it('reads and writes only the file given with --prs', async () => {
    const defaultList = JSON.stringify({
      version: 1,
      pullRequests: [{ url: PR_B, addedAt: '2026-01-01T00:00:00.000Z' }],
    });
    await writeFile(prsPath(), defaultList);
    const ownList = join(configDir, 'lists', 'mine.json');

    const result = await runCli(['serve', '--port', '0', '--no-open', '--prs', ownList]);
    expect(result.code).toBe(0);
    const state = await readState();
    const base = `http://${state.host}:${state.port}`;
    await runCli(['--pr', PR_A, '--no-open']);

    expect((await restoredSessions(base)).map((session) => session.prUrl)).toEqual([PR_A]);
    expect(await savedUrls(ownList)).toEqual([PR_A]);
    expect(await readFile(prsPath(), 'utf8')).toBe(defaultList);
    const info = await (await fetch(`${base}/api/server-info`)).json();
    expect(info).toMatchObject({ prList: { path: ownList } });
  });

  it('hands the background server --prs as an absolute path', async () => {
    const result = await runCli(['serve', '--background', '--port', '0', '--prs', 'mine.json']);

    expect(result.code).toBe(0);
    expect(fakes.spawnBackgroundChild).toHaveBeenCalledWith([
      'serve',
      '--no-open',
      '--port',
      '0',
      '--prs',
      resolve('mine.json'),
    ]);
  });

  it('starts with a broken list, warns, and never overwrites it', async () => {
    const broken = '{"version": 1, "pullRequests": [';
    await writeFile(prsPath(), broken);

    const result = await runCli(['serve', '--port', '0', '--no-open']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(prsPath());
    const state = await readState();
    const base = `http://${state.host}:${state.port}`;
    const info = (await (await fetch(`${base}/api/server-info`)).json()) as {
      prList: { path: string; warning?: string };
    };
    expect(info.prList).toEqual({ path: prsPath(), warning: expect.stringContaining(prsPath()) });
    expect((await runCli(['--pr', PR_A, '--no-open'])).code).toBe(0);
    expect(await listSessions(base)).toEqual([expect.objectContaining({ prUrl: PR_A })]);
    expect(await readFile(prsPath(), 'utf8')).toBe(broken);
  });
});

describe('difit comment', () => {
  async function serveWithPr() {
    const { base } = await serve();
    await runCli(['--pr', PR_A, '--no-open']);
    const [session] = await listSessions(base);
    if (!session) {
      throw new Error('no session');
    }
    return { base, id: session.id };
  }

  it('adds, reads, and resolves comments of a session on the running server', async () => {
    const { id } = await serveWithPr();

    const add = await runCli(['comment', 'add', '--session', id, comment('t1', 'via session')]);
    const get = await runCli(['comment', 'get', '--session', id, '--format', 'json']);
    const resolve = await runCli(['comment', 'resolve', 't1', '--session', id]);
    const after = await runCli(['comment', 'get', '--session', id, '--format', 'json']);

    expect(add.code).toBe(0);
    expect(get.stdout).toContain('via session');
    expect(resolve.code).toBe(0);
    expect(JSON.parse(resolve.stdout)).toMatchObject({ success: true, resolved: ['t1'] });
    expect(after.stdout).not.toContain('via session');
  });

  it('finds the session from --pr', async () => {
    await serveWithPr();

    await runCli(['comment', 'add', '--pr', PR_A, comment('t2', 'via pr url')]);
    const get = await runCli(['comment', 'get', '--pr', PR_A, '--format', 'json']);

    expect(get.code).toBe(0);
    expect(get.stdout).toContain('via pr url');
  });

  it('finds the session from the pages, trailing slash, query, and fragment of the PR', async () => {
    await serveWithPr();

    const add = await runCli([
      'comment',
      'add',
      '--pr',
      `${PR_A}/files`,
      comment('t3', 'via page'),
    ]);
    const get = await runCli(['comment', 'get', '--pr', `${PR_A}/?x=1#y`, '--format', 'json']);

    expect(add.code).toBe(0);
    expect(get.code).toBe(0);
    expect(get.stdout).toContain('via page');
  });

  it('rejects a GitHub Enterprise --pr and points to --standalone', async () => {
    const result = await runCli([
      'comment',
      'get',
      '--pr',
      'https://ghe.example.internal/acme/widgets/pull/12',
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--standalone');
  });

  describe('against a recording server', () => {
    let requests: string[];
    let port: number;

    beforeEach(async () => {
      requests = [];
      const server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      });
      otherServers.push(server);
      // The CLI calls --port on localhost.
      await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
      port = (server.address() as AddressInfo).port;
    });

    it('keeps --port alone at the root API', async () => {
      await runCli(['comment', 'get', '--port', String(port), '--format', 'json']);
      await runCli(['comment', 'resolve', 'x1', '--port', String(port)]);

      expect(requests).toEqual(['GET /api/comments-json', 'DELETE /api/comments/x1']);
    });

    it('prefixes /s/<id> when --session is given with --port', async () => {
      const id = '0123456789abcdef';

      await runCli(['comment', 'get', '--session', id, '--port', String(port), '--format', 'json']);

      expect(requests).toEqual([`GET /s/${id}/api/comments-json`]);
    });
  });

  it('needs --port, --session, or --pr', async () => {
    const result = await runCli(['comment', 'get']);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--port/);
  });

  it('rejects a session id that is not one', async () => {
    const result = await runCli(['comment', 'get', '--session', '../etc', '--port', '1']);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--session/);
  });
});

describe('difit review', () => {
  const putReview = (base: string, id: string, state: 'done' | 'none') =>
    fetch(`${base}/api/sessions/${id}/review`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });

  async function serveWithTwoPrs() {
    const { base } = await serve();
    await runCli(['--pr', PR_A, '--no-open']);
    await runCli(['--pr', PR_B, '--no-open']);
    const [a, b] = await listSessions(base);
    if (!a || !b) {
      throw new Error('no sessions');
    }
    return { base, a, b };
  }

  const listed = async (...args: string[]) => {
    const result = await runCli(['review', 'list', '--json', ...args]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    return JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  };

  // A server that answers server-info as the difit server of this process and sessions
  // with the given rows, recording every request.
  async function startFakeDifit(sessions: unknown[], answer: { status: number; body: unknown }) {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url} ${req.headers['content-type'] ?? ''}`.trim());
      res.writeHead(
        req.url === '/api/server-info' || req.url === '/api/sessions' ? 200 : answer.status,
        {
          'Content-Type': 'application/json',
        },
      );
      res.end(
        JSON.stringify(
          req.url === '/api/server-info'
            ? { app: 'difit', mode: 'multi', pid: process.pid }
            : req.url === '/api/sessions'
              ? { sessions }
              : answer.body,
        ),
      );
    });
    otherServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    await writeState({
      pid: process.pid,
      host: 'localhost',
      port: (server.address() as AddressInfo).port,
    });
    return requests;
  }

  const row = (extra: Record<string, unknown>) => ({
    id: 'aaaaaaaaaaaaaaaa',
    prUrl: PR_A,
    label: 'octo/alpha#1',
    status: 'open',
    url: '/s/aaaaaaaaaaaaaaaa/',
    createdAt: '2026-01-01T00:00:00.000Z',
    review: { state: 'none' },
    commentCount: 0,
    ...extra,
  });

  it('is a subcommand listed by --help, so a script can tell it exists before calling it', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });

    const root = await runCli(['--help']);
    const review = await runCli(['review', '--help']);
    const list = await runCli(['review', 'list', '--help']);

    expect([root.code, review.code, list.code]).toEqual([0, 0, 0]);
    const [rootHelp = '', reviewHelp = '', listHelp = ''] = written
      .join('')
      .split(/(?=^Usage: difit)/m);
    expect(rootHelp).toMatch(/^Commands:\n(?:  .*\n)*?  review\b/m);
    expect(reviewHelp).toMatch(/^Commands:\n(?:  .*\n)*?  list\b(?:.*\n)(?:  .*\n)*?  ack\b/m);
    expect(listHelp).toMatch(/--done/);
    expect(listHelp).toMatch(/--json/);
  });

  describe('list', () => {
    it('prints url, id, label, doneAt, and commentCount of the PRs marked done', async () => {
      const { base, a, b } = await serveWithTwoPrs();
      await runCli(['comment', 'add', '--pr', PR_A, comment('t1', 'first')]);
      await runCli(['comment', 'add', '--pr', PR_A, comment('t2', 'second')]);
      expect(await listed('--done')).toEqual([]);

      expect((await putReview(base, a.id, 'done')).status).toBe(200);

      const done = await listed('--done');
      expect(done).toEqual([
        {
          url: PR_A,
          id: a.id,
          label: 'octo/alpha#1',
          doneAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          commentCount: 2,
          state: 'done',
        },
      ]);
      expect(Object.keys(done[0] ?? {})).toEqual(
        expect.arrayContaining(['url', 'id', 'label', 'doneAt', 'commentCount']),
      );
      const everyone = await listed();
      expect(everyone.map((entry) => [entry.id, entry.state, entry.doneAt])).toEqual([
        [a.id, 'done', done[0]?.doneAt],
        [b.id, 'none', null],
      ]);
    });

    it('leaves out PRs that are acknowledged or not marked', async () => {
      const { base, a, b } = await serveWithTwoPrs();
      await putReview(base, a.id, 'done');
      await putReview(base, b.id, 'done');
      await runCli(['review', 'ack', '--pr', PR_B]);

      expect((await listed('--done')).map((entry) => entry.id)).toEqual([a.id]);
      await putReview(base, a.id, 'none');
      expect(await listed('--done')).toEqual([]);
    });

    it('lists a PR again when it is set back to none and marked done again', async () => {
      const { base, a } = await serveWithTwoPrs();
      await putReview(base, a.id, 'done');
      const [first] = await listed('--done');
      await runCli(['review', 'ack', '--pr', PR_A]);
      expect(await listed('--done')).toEqual([]);

      await putReview(base, a.id, 'none');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await putReview(base, a.id, 'done');

      const [again] = await listed('--done');
      expect(again).toMatchObject({ id: a.id });
      expect(again?.doneAt).not.toBe(first?.doneAt);
    });

    it('keeps the done marks across difit stop and difit serve', async () => {
      const { base, a } = await serveWithTwoPrs();
      await putReview(base, a.id, 'done');
      const [before] = await listed('--done');
      expect((await runCli(['stop'])).code).toBe(0);

      const { base: next } = await serve();
      await restoredSessions(next);

      expect(await listed('--done')).toEqual([before]);
    });

    it('prints [] and exits 0 when no server is running, without starting one or reading GitHub', async () => {
      const none = await runCli(['review', 'list', '--done', '--json']);
      await writeState({ pid: DEAD_PID });
      const stale = await runCli(['review', 'list', '--done', '--json']);

      for (const result of [none, stale]) {
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('[]');
        expect(result.stderr).toBe('');
      }
      expect(fakes.spawnBackgroundChild).not.toHaveBeenCalled();
      expect(vi.mocked(startServer)).not.toHaveBeenCalled();
    });

    it('prints nothing in text mode when there is nothing to list', async () => {
      const result = await runCli(['review', 'list', '--done']);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('prints one line per PR in text mode', async () => {
      const { base, a } = await serveWithTwoPrs();
      await putReview(base, a.id, 'done');

      const result = await runCli(['review', 'list', '--done']);

      expect(result.code).toBe(0);
      expect(result.stdout.split('\n')).toEqual([expect.stringContaining(PR_A)]);
      expect(result.stdout).toContain('octo/alpha#1');
    });

    it('skips a done PR whose session is not open yet, as its comments are not loaded', async () => {
      const requests = await startFakeDifit(
        [
          row({ review: { state: 'done', doneAt: '2026-02-03T04:05:06.000Z' }, commentCount: 3 }),
          row({
            id: 'bbbbbbbbbbbbbbbb',
            prUrl: PR_B,
            label: 'octo/beta#2',
            status: 'restoring',
            url: undefined,
            commentCount: undefined,
            review: { state: 'done', doneAt: '2026-02-03T04:05:06.000Z' },
          }),
          row({
            id: 'cccccccccccccccc',
            prUrl: PR_C,
            label: 'octo/gamma#3',
            status: 'failed',
            url: undefined,
            commentCount: undefined,
            error: 'x',
            review: { state: 'done', doneAt: '2026-02-03T04:05:06.000Z' },
          }),
        ],
        { status: 500, body: {} },
      );

      expect(await listed('--done')).toEqual([
        {
          url: PR_A,
          id: 'aaaaaaaaaaaaaaaa',
          label: 'octo/alpha#1',
          doneAt: '2026-02-03T04:05:06.000Z',
          commentCount: 3,
          state: 'done',
        },
      ]);
      expect(requests.filter((request) => !request.includes('server-info'))).toEqual([
        'GET /api/sessions',
      ]);
    });

    it('fails, and does not say there is nothing to list, when the server does not answer', async () => {
      const port = await startUnresponsiveApp();
      await writeState({ pid: process.pid, port });

      const result = await runCli(['review', 'list', '--done', '--json']);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/not answering/);
    });
  });

  describe('ack', () => {
    it('acknowledges the done PR of --pr, which then leaves list --done', async () => {
      const { base, a } = await serveWithTwoPrs();
      await putReview(base, a.id, 'done');

      const result = await runCli(['review', 'ack', '--pr', PR_A]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        id: a.id,
        url: PR_A,
        state: 'acknowledged',
        acknowledgedAt: expect.any(String),
      });
      expect(await listed('--done')).toEqual([]);
      const rows = (await (await fetch(`${base}/api/sessions`)).json()) as {
        sessions: Array<{ id: string; review: { state: string } }>;
      };
      expect(rows.sessions.map((session) => session.review.state)).toEqual([
        'acknowledged',
        'none',
      ]);
    });

    it('exits 1 when the PR is not done, or was acknowledged already', async () => {
      const { base, a } = await serveWithTwoPrs();

      const none = await runCli(['review', 'ack', '--pr', PR_A]);
      await putReview(base, a.id, 'done');
      const first = await runCli(['review', 'ack', '--pr', PR_A]);
      const again = await runCli(['review', 'ack', '--pr', PR_A]);

      expect(none.code).toBe(1);
      expect(none.stderr).toMatch(/not done/i);
      expect(first.code).toBe(0);
      expect(again.code).toBe(1);
      expect(again.stderr).toMatch(/not done/i);
    });

    it('exits 1 for a PR the server does not list', async () => {
      await serveWithTwoPrs();

      const result = await runCli(['review', 'ack', '--pr', PR_C]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/not in the difit server's list|not on the server/i);
    });

    it('finds the PR from its pages, trailing slash, query, and fragment, as comment --pr does', async () => {
      const { base, a } = await serveWithTwoPrs();
      await putReview(base, a.id, 'done');

      const result = await runCli(['review', 'ack', '--pr', `${PR_A}/files?x=1#y`]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ id: a.id, url: PR_A });
    });

    it('rejects a GitHub Enterprise URL before asking any server, and needs --pr', async () => {
      const requests = await startFakeDifit([], { status: 200, body: {} });

      const ghe = await runCli([
        'review',
        'ack',
        '--pr',
        'https://ghe.example.internal/acme/widgets/pull/12',
      ]);
      const bare = await runCli(['review', 'ack']);

      expect(ghe.code).toBe(1);
      expect(ghe.stderr).toContain('--standalone');
      expect(bare.code).toBe(1);
      expect(bare.stderr).toMatch(/--pr/);
      expect(requests.filter((request) => !request.includes('server-info'))).toEqual([]);
    });

    it('exits 1 and says so when no server is running', async () => {
      const result = await runCli(['review', 'ack', '--pr', PR_A]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/No difit server is running/);
      expect(fakes.spawnBackgroundChild).not.toHaveBeenCalled();
    });

    it('posts to the review/ack route of the PR session with a JSON content type', async () => {
      const requests = await startFakeDifit([], {
        status: 200,
        body: { success: true, id: 'aaaaaaaaaaaaaaaa', review: { state: 'acknowledged' } },
      });

      const result = await runCli(['review', 'ack', '--pr', PR_A]);

      const id = sessionIdForPullRequest(PR_A);
      expect(result.code).toBe(0);
      expect(requests.filter((request) => !request.includes('server-info'))).toEqual([
        `POST /api/sessions/${id}/review/ack application/json`,
      ]);
    });
  });
});
