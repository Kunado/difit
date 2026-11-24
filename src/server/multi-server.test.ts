import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { request as httpRequest, type Server } from 'http';
import { type AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { fetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../package.json' with { type: 'json' };
import { getPrCommentImports, getPrPatch, getPrSummary } from '../cli/github.js';
import { type CommentImport } from '../types/diff.js';
import { SESSION_PATH_PATTERN } from '../utils/sessionPath.js';

import {
  createMultiSessionApp,
  type PullRequestSource,
  type PullRequestSummary,
  startMultiServer,
} from './multi-server.js';
import { openPrList } from './pr-list.js';

const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }));

// The gh-backed PullRequestSource runs gh through ghMock, as in cli/github.test.ts.
// Synchronous runs fail the test, so no test reaches the real gh. Named imports of a
// built-in resolve through `default`, so the mock replaces both.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  const execFile = Object.assign(
    (file: string, args: string[], options: object, callback: (...result: unknown[]) => void) => {
      ghMock(file, args, options).then(
        ({ stdout, stderr }: { stdout: string; stderr: string }) => callback(null, stdout, stderr),
        (error: unknown) => callback(error, '', ''),
      );
    },
    { [promisify.custom]: (...args: unknown[]) => ghMock(...args) },
  );
  const mocked = {
    ...actual,
    execFile,
    execFileSync: () => {
      throw new Error('gh must not run synchronously');
    },
  };
  return { ...mocked, default: mocked };
});

const PR_A = 'https://github.com/octo/alpha/pull/1';
const PR_B = 'https://github.com/octo/beta/pull/2';
const isoNow = '2024-01-01T00:00:00Z';

const openServers: Server[] = [];
const openStreams: AbortController[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const controller of openStreams.splice(0)) {
    controller.abort();
  }
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'difit-prs-'));
  tempDirs.push(dir);
  return dir;
}

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

const commentImport = (id: string, filePath: string, body: string): CommentImport => ({
  type: 'thread',
  id,
  filePath,
  position: { side: 'new', line: 1 },
  body,
  createdAt: isoNow,
  updatedAt: isoNow,
});

function fakeGitHub() {
  return {
    getPrPatch: vi.fn(async (prUrl: string) => patchFor(fileOf(prUrl))),
    getPrCommentImports: vi.fn(async (_prUrl: string): Promise<CommentImport[]> => []),
    getPrSummary: vi.fn(
      async (prUrl: string): Promise<PullRequestSummary> => ({
        title: `Title of ${prUrl}`,
        state: 'OPEN',
      }),
    ),
  } satisfies PullRequestSource;
}

// Holds the next gh pr diff until the returned function is called.
function holdPatch(github: ReturnType<typeof fakeGitHub>) {
  let release = () => {};
  github.getPrPatch.mockImplementationOnce(
    (prUrl: string) =>
      new Promise<string>((resolve) => {
        release = () => resolve(patchFor(fileOf(prUrl)));
      }),
  );
  return () => release();
}

// Holds the next gh pr view until the returned function is called with the PR's state.
function holdSummary(github: ReturnType<typeof fakeGitHub>) {
  let release = (_state: PullRequestSummary['state']) => {};
  github.getPrSummary.mockImplementationOnce(
    (prUrl: string) =>
      new Promise<PullRequestSummary>((resolve) => {
        release = (state) => resolve({ title: `Title of ${prUrl}`, state });
      }),
  );
  return (state: PullRequestSummary['state'] = 'OPEN') => release(state);
}

// Each app saves its PR list to a prs.json of its own unless the test names one.
async function startApp(
  github: PullRequestSource = fakeGitHub(),
  options: { clientDir?: string; prsPath?: string } = {},
) {
  const { prsPath = join(await makeTempDir(), 'prs.json'), ...appOptions } = options;
  const prList = await openPrList(prsPath);
  const { app, restoreSessions } = createMultiSessionApp({ github, prList, ...appOptions });
  const server = app.listen(0, '127.0.0.1');
  openServers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, port, github, prsPath, restoreSessions };
}

const readPrsFile = async (prsPath: string) => JSON.parse(await readFile(prsPath, 'utf8'));

const savedUrls = async (prsPath: string) =>
  ((await readPrsFile(prsPath)) as { pullRequests: Array<{ url: string }> }).pullRequests.map(
    (row) => row.url,
  );

async function writePrsFile(rows: unknown[]): Promise<string> {
  const prsPath = join(await makeTempDir(), 'prs.json');
  await writeFile(prsPath, JSON.stringify({ version: 1, pullRequests: rows }));
  return prsPath;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

const createSession = (base: string, body: unknown) =>
  fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });

async function openPr(base: string, prUrl: string, extra: Record<string, unknown> = {}) {
  const response = await createSession(base, { prUrl, ...extra });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; url: string };
}

const deleteSession = (base: string, id: string) =>
  fetch(`${base}/api/sessions/${id}`, { method: 'DELETE', headers: jsonHeaders });

const getJson = async (url: string) => (await fetch(url)).json() as Promise<any>;

const listSessions = async (base: string) =>
  ((await getJson(`${base}/api/sessions`)) as { sessions: Array<{ id: string; label: string }> })
    .sessions;

const postComments = (url: string, threads: unknown[]) =>
  fetch(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ threads }) });

const makeThread = (id: string, filePath: string, body: string) => ({
  id,
  filePath,
  createdAt: isoNow,
  updatedAt: isoNow,
  position: { side: 'new' as const, line: 1 },
  messages: [{ id, body, createdAt: isoNow, updatedAt: isoNow }],
});

// Raw request so tests control headers that fetch would set on its own (Host, Origin).
function rawRequest(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string },
) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: options.method,
          path: options.path,
          headers: options.headers,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end(options.body);
    },
  );
}

interface EventStream {
  events: Array<{ type: string; version?: number }>;
  ended: Promise<void>;
}

// Reads an SSE response; `ended` resolves when the server ends the response.
async function openEventStream(url: string): Promise<EventStream> {
  const controller = new AbortController();
  openStreams.push(controller);
  const response = await fetch(url, { signal: controller.signal });
  expect(response.status).toBe(200);
  const events: EventStream['events'] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const ended = (async () => {
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const data = buffer.slice('data: '.length, end);
        // Watch events are JSON; heartbeat events are bare words.
        const { type, version } = data.startsWith('{') ? JSON.parse(data) : { type: data };
        events.push(version === undefined ? { type } : { type, version });
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
      }
    }
  })();
  // Aborted streams reject in afterEach; only a server-side end resolves.
  ended.catch(() => {});
  return { events, ended };
}

const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

describe('POST /api/sessions', () => {
  it('fetches the PR with gh, then serves it under the returned /s/<id>/ path', async () => {
    const github = fakeGitHub();
    github.getPrCommentImports.mockResolvedValue([
      commentImport('gh-1', 'alpha.ts', 'from GitHub'),
    ]);
    const { base } = await startApp(github);

    const response = await createSession(base, {
      prUrl: PR_A,
      commentImports: [commentImport('bot-1', 'alpha.ts', 'from the bot')],
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, string>;
    expect(body).toEqual({
      id: expect.stringMatching(/^[a-z0-9-]+$/),
      status: 'open',
      url: `/s/${body.id}/`,
      prUrl: PR_A,
      label: 'octo/alpha#1',
      title: `Title of ${PR_A}`,
      createdAt: expect.any(String),
    });
    expect(new Date(body.createdAt!).toISOString()).toBe(body.createdAt);
    expect(github.getPrPatch).toHaveBeenCalledWith(PR_A);
    expect(github.getPrCommentImports).toHaveBeenCalledWith(PR_A);

    const diff = await getJson(`${base}${body.url}api/diff`);
    expect(diff.files.map((file: { path: string }) => file.path)).toEqual(['alpha.ts']);

    const comments = await getJson(`${base}${body.url}api/comments-json`);
    expect(comments.threads.map((thread: { id: string }) => thread.id)).toEqual(['gh-1', 'bot-1']);
  });

  it('returns the existing session for the same PR without fetching it again', async () => {
    const { base, github } = await startApp();
    const first = await openPr(base, PR_A);

    const again = await createSession(base, { prUrl: PR_A });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);

    // GitHub owner and repository names are case-insensitive.
    const otherCase = await createSession(base, {
      prUrl: 'https://github.com/Octo/Alpha/pull/1',
    });
    expect(otherCase.status).toBe(200);
    expect(await otherCase.json()).toEqual(first);

    expect(await listSessions(base)).toHaveLength(1);
    expect(github.getPrPatch).toHaveBeenCalledTimes(1);
  });

  it('shares one gh fetch between concurrent requests for the same PR', async () => {
    const github = fakeGitHub();
    const releasePatch = holdPatch(github);
    const { base } = await startApp(github);

    const first = createSession(base, { prUrl: PR_A });
    await vi.waitFor(() => expect(github.getPrPatch).toHaveBeenCalledTimes(1));
    const second = createSession(base, {
      prUrl: PR_A,
      commentImports: [commentImport('late-1', 'alpha.ts', 'sent while gh ran')],
    });
    // Let the second request reach the server while gh is still running.
    await new Promise((resolve) => setTimeout(resolve, 100));
    releasePatch();

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([201, 200]);
    const [a, b] = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      url: string;
    }>;
    expect(b).toEqual(a);
    expect(await listSessions(base)).toHaveLength(1);
    expect(github.getPrPatch).toHaveBeenCalledTimes(1);
    const comments = await getJson(`${base}${a!.url}api/comments-json`);
    expect(comments.threads.map((thread: { id: string }) => thread.id)).toEqual(['late-1']);
  });

  it('adds commentImports sent for an open session to that session', async () => {
    const { base } = await startApp();
    const a = await openPr(base, PR_A, {
      commentImports: [commentImport('bot-1', 'alpha.ts', 'first pass')],
    });
    const watch = await openEventStream(`${base}${a.url}api/watch`);
    await vi.waitFor(() => expect(watch.events).toEqual([{ type: 'connected' }]));

    const again = await createSession(base, {
      prUrl: PR_A,
      commentImports: [commentImport('bot-2', 'alpha.ts', 'second pass')],
    });

    expect(again.status).toBe(200);
    const comments = await getJson(`${base}${a.url}api/comments-json`);
    expect(comments.threads.map((thread: { id: string }) => thread.id)).toEqual(['bot-1', 'bot-2']);
    await vi.waitFor(() =>
      expect(watch.events).toEqual([
        { type: 'connected' },
        { type: 'commentsChanged', version: 2 },
      ]),
    );
  });

  it.each([
    ['missing', undefined],
    ['not a string', 42],
    ['http scheme', 'http://github.com/octo/alpha/pull/1'],
    ['upper-case scheme', 'HTTPS://github.com/octo/alpha/pull/1'],
    ['other host', 'https://gitlab.com/octo/alpha/pull/1'],
    ['host lookalike', 'https://github.com.evil.example/octo/alpha/pull/1'],
    ['subdomain', 'https://www.github.com/octo/alpha/pull/1'],
    ['explicit port', 'https://github.com:443/octo/alpha/pull/1'],
    ['credentials', 'https://user:secret@github.com/octo/alpha/pull/1'],
    ['issue URL', 'https://github.com/octo/alpha/issues/1'],
    ['files tab', 'https://github.com/octo/alpha/pull/1/files'],
    ['trailing slash', 'https://github.com/octo/alpha/pull/1/'],
    ['query', 'https://github.com/octo/alpha/pull/1?tab=files'],
    ['fragment', 'https://github.com/octo/alpha/pull/1#discussion'],
    ['dot-dot segment', 'https://github.com/octo/../pull/1'],
    ['dot-dot in repo', 'https://github.com/octo/al..pha/pull/1'],
    ['.git suffix', 'https://github.com/octo/alpha.git/pull/1'],
    ['single-dot repo', 'https://github.com/octo/./pull/1'],
    ['encoded characters', 'https://github.com/octo/al%2Fpha/pull/1'],
    ['space', 'https://github.com/octo/al pha/pull/1'],
    ['trailing newline', `${PR_A}\n`],
    ['leading hyphen', `-${PR_A}`],
    ['option-like value', '--help'],
    ['owner starting with a hyphen', 'https://github.com/-octo/alpha/pull/1'],
    ['repo starting with a hyphen', 'https://github.com/octo/-alpha/pull/1'],
    ['non-numeric number', 'https://github.com/octo/alpha/pull/abc'],
    ['zero', 'https://github.com/octo/alpha/pull/0'],
    ['leading zero', 'https://github.com/octo/alpha/pull/01'],
    ['number above GraphQL Int', 'https://github.com/octo/alpha/pull/2147483648'],
  ])('rejects a PR URL that is %s with 400 and never runs gh', async (_name, prUrl) => {
    const { base, github } = await startApp();

    const response = await createSession(base, { prUrl });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining('prUrl') });
    expect(github.getPrPatch).not.toHaveBeenCalled();
    expect(await listSessions(base)).toEqual([]);
  });

  it('accepts repository names GitHub allows, such as .github and dotted names', async () => {
    const { base } = await startApp();

    await openPr(base, 'https://github.com/octo/.github/pull/7');
    await openPr(base, 'https://github.com/octo-org/my_repo.js/pull/2147483647');

    expect((await listSessions(base)).map((session) => session.label)).toEqual([
      'octo/.github#7',
      'octo-org/my_repo.js#2147483647',
    ]);
  });

  it.each([
    ['a body that is not an object', [PR_A]],
    ['invalid commentImports', { prUrl: PR_A, commentImports: [{ type: 'nope' }] }],
    ['a non-boolean clean', { prUrl: PR_A, clean: 'yes' }],
  ])('rejects %s with 400', async (_name, body) => {
    const { base, github } = await startApp();

    const response = await createSession(base, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(github.getPrPatch).not.toHaveBeenCalled();
  });

  it('answers 502 without gh output when gh fails, and keeps no session', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const github = fakeGitHub();
    github.getPrPatch.mockRejectedValueOnce(
      new Error(
        'HTTP 401: Bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123456789\nTry: gh auth login',
      ),
    );
    const { base } = await startApp(github);

    const response = await createSession(base, { prUrl: PR_A });

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: expect.stringContaining('gh') });
    expect(text).not.toContain('Bad credentials');
    expect(text).not.toContain('ghp_');
    expect(await listSessions(base)).toEqual([]);
    const logged = consoleError.mock.calls.flat().join('\n');
    expect(logged).toContain('octo/alpha#1');
    expect(logged).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');

    // The failure is not cached: the next request fetches again and succeeds.
    await openPr(base, PR_A);
    expect(github.getPrPatch).toHaveBeenCalledTimes(2);
  });

  it('still creates the session when only the review comments or the title fail', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const github = fakeGitHub();
    github.getPrCommentImports.mockRejectedValue(new Error('GraphQL: rate limited'));
    github.getPrSummary.mockRejectedValue(new Error('gh pr view failed'));
    const { base } = await startApp(github);

    const response = await createSession(base, {
      prUrl: PR_A,
      commentImports: [commentImport('bot-1', 'alpha.ts', 'from the bot')],
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { url: string; title?: string };
    expect(body.title).toBeUndefined();
    const comments = await getJson(`${base}${body.url}api/comments-json`);
    expect(comments.threads.map((thread: { id: string }) => thread.id)).toEqual(['bot-1']);
    expect(consoleWarn.mock.calls.flat().join('\n')).toContain('octo/alpha#1');
  });

  it('answers 500 when the session cannot be built, and logs the stack with tokens masked', async () => {
    // vitest.setup.ts makes console.error one vi.fn for every test, so drop earlier calls.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleError.mockClear();
    const github = fakeGitHub();
    function throwTokenError(): never {
      throw new Error('unexpected ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    }
    // A review comment that throws when read stands in for any unexpected failure.
    github.getPrCommentImports.mockResolvedValue([
      {
        get type(): never {
          return throwTokenError();
        },
      } as unknown as CommentImport,
    ]);
    const { base } = await startApp(github);

    const response = await createSession(base, { prUrl: PR_A });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to open the session' });
    const logged = consoleError.mock.calls.flat().join('\n');
    expect(logged).toContain(
      'Failed to open a session for octo/alpha#1: Error: unexpected [redacted]\n',
    );
    expect(logged).toMatch(/\n\s+at throwTokenError /);
    expect(logged).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(await listSessions(base)).toEqual([]);
  });
});

describe('a gh run that never exits', () => {
  const ghSource: PullRequestSource = { getPrPatch, getPrCommentImports, getPrSummary };

  // Like execFile, a run fails once its options.timeout elapses, which is when the returned
  // function is called. A run without a timeout hangs.
  function hangGh() {
    const elapse: Array<() => void> = [];
    ghMock.mockImplementation(
      (file: string, args: string[], options: { timeout?: number; killSignal?: string }) =>
        new Promise((_resolve, reject) => {
          if (options.timeout !== undefined && options.timeout > 0) {
            elapse.push(() =>
              reject(
                Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}\n`), {
                  killed: true,
                  code: null,
                  signal: options.killSignal ?? 'SIGTERM',
                  stdout: '',
                  stderr: '',
                }),
              ),
            );
          }
        }),
    );
    return () => {
      for (const fire of elapse.splice(0)) {
        fire();
      }
    };
  }

  // Answers gh pr diff, gh api graphql, and gh pr view for PR_A.
  function answerGh(_file: string, args: string[]) {
    const stdout =
      args[0] === 'api'
        ? JSON.stringify({ data: null })
        : args[1] === 'view'
          ? JSON.stringify({ title: 'Alpha', state: 'OPEN' })
          : patchFor('alpha.ts');
    return Promise.resolve({ stdout, stderr: '' });
  }

  afterEach(() => {
    ghMock.mockReset();
  });

  it('answers 502 once gh times out, then lets the same PR be opened again', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const elapseTimeout = hangGh();
    const { base } = await startApp(ghSource);
    // Ids are deterministic, so another server tells the id before this one finishes.
    const { id } = await openPr((await startApp()).base, PR_A);

    const creation = createSession(base, { prUrl: PR_A });
    await vi.waitFor(() => expect(ghMock).toHaveBeenCalledTimes(3));
    expect((await deleteSession(base, id)).status).toBe(409);

    elapseTimeout();

    const response = await creation;
    expect((await deleteSession(base, id)).status).toBe(404);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error:
        'Could not fetch the pull request with gh. Check that it exists and that gh is installed and logged in (gh auth status). The server log has the details.',
    });
    expect(consoleError.mock.calls.flat().join('\n')).toContain(
      'Failed to fetch octo/alpha#1 with gh: gh timed out after 90 seconds',
    );
    expect(await listSessions(base)).toEqual([]);

    ghMock.mockImplementation(answerGh);
    await openPr(base, PR_A);
    expect((await listSessions(base)).map((session) => session.id)).toEqual([id]);
  });
});

describe('session isolation', () => {
  it('keeps diffs, comments, and repository ids separate per PR', async () => {
    const { base } = await startApp();
    const a = await openPr(base, PR_A);
    const b = await openPr(base, PR_B);

    const diffA = await getJson(`${base}${a.url}api/diff`);
    const diffB = await getJson(`${base}${b.url}api/diff`);
    expect(diffA.files.map((file: { path: string }) => file.path)).toEqual(['alpha.ts']);
    expect(diffB.files.map((file: { path: string }) => file.path)).toEqual(['beta.ts']);
    expect(diffA.repositoryId).not.toBe(diffB.repositoryId);

    const response = await postComments(`${base}${a.url}api/comments`, [
      makeThread('a1', 'alpha.ts', 'only in a'),
    ]);
    expect(response.status).toBe(200);

    expect(await getJson(`${base}${a.url}api/comments-json`)).toMatchObject({
      version: 1,
      threads: [{ id: 'a1' }],
    });
    expect(await getJson(`${base}${b.url}api/comments-json`)).toEqual({ version: 0, threads: [] });
  });

  it('keeps watch streams and commentsChanged events per PR', async () => {
    const { base } = await startApp();
    const a = await openPr(base, PR_A);
    const b = await openPr(base, PR_B);
    const streamA = await openEventStream(`${base}${a.url}api/watch`);
    const streamB = await openEventStream(`${base}${b.url}api/watch`);
    await vi.waitFor(() => {
      expect(streamA.events).toEqual([{ type: 'connected' }]);
      expect(streamB.events).toEqual([{ type: 'connected' }]);
    });

    await postComments(`${base}${a.url}api/comments`, [makeThread('a1', 'alpha.ts', 'in a')]);
    await postComments(`${base}${b.url}api/comments`, [makeThread('b1', 'beta.ts', 'in b')]);

    await vi.waitFor(() => {
      expect(streamA.events).toEqual([
        { type: 'connected' },
        { type: 'commentsChanged', version: 1 },
      ]);
      expect(streamB.events).toEqual([
        { type: 'connected' },
        { type: 'commentsChanged', version: 1 },
      ]);
    });
  });
});

describe('session ids', () => {
  it('derives the session id and repository id from the PR URL alone', async () => {
    const first = await startApp();
    const second = await startApp();

    const a1 = await openPr(first.base, PR_A);
    const a2 = await openPr(second.base, PR_A);
    const b1 = await openPr(first.base, PR_B);

    expect(a2.id).toBe(a1.id);
    expect(b1.id).not.toBe(a1.id);

    const repositoryId = async (base: string, url: string) =>
      (await getJson(`${base}${url}api/diff`)).repositoryId as string;
    const repoA1 = await repositoryId(first.base, a1.url);
    expect(repoA1).toEqual(expect.any(String));
    expect(await repositoryId(second.base, a2.url)).toBe(repoA1);
    expect(await repositoryId(first.base, b1.url)).not.toBe(repoA1);

    // Reopening after a delete restores the same id, so browser storage carries over.
    expect((await deleteSession(first.base, a1.id)).status).toBe(200);
    const reopened = await openPr(first.base, PR_A);
    expect(reopened.id).toBe(a1.id);
    expect(await repositoryId(first.base, reopened.url)).toBe(repoA1);
  });
});

describe('GET /api/sessions', () => {
  it('lists open sessions in creation order', async () => {
    const { base } = await startApp();
    expect(await listSessions(base)).toEqual([]);

    const b = await openPr(base, PR_B);
    const a = await openPr(base, PR_A);
    expect(await listSessions(base)).toEqual([b, a]);

    await deleteSession(base, b.id);
    const reopenedB = await openPr(base, PR_B);
    expect(await listSessions(base)).toEqual([a, reopenedB]);
  });
});

describe('DELETE /api/sessions/:id', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops the session and ends its event streams, leaving other sessions open', async () => {
    const { base } = await startApp();
    const a = await openPr(base, PR_A);
    const b = await openPr(base, PR_B);
    const watchA = await openEventStream(`${base}${a.url}api/watch`);
    const heartbeatA = await openEventStream(`${base}${a.url}api/heartbeat`);
    // Express routes ignore case and a trailing slash, so these reach the same handlers.
    const watchVariantA = await openEventStream(`${base}${a.url}API/Watch/`);
    const heartbeatVariantA = await openEventStream(`${base}${a.url}api/heartbeat/`);
    const watchB = await openEventStream(`${base}${b.url}api/watch`);
    await vi.waitFor(() => {
      expect(watchA.events).toEqual([{ type: 'connected' }]);
      expect(heartbeatA.events).toEqual([{ type: 'connected' }]);
      expect(watchVariantA.events).toEqual([{ type: 'connected' }]);
      expect(heartbeatVariantA.events).toEqual([{ type: 'connected' }]);
      expect(watchB.events).toEqual([{ type: 'connected' }]);
    });

    const response = await deleteSession(base, a.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, id: a.id });
    for (const stream of [watchA, heartbeatA, watchVariantA, heartbeatVariantA]) {
      expect(await settledWithin(stream.ended, 2000)).toBe(true);
    }
    expect(await settledWithin(watchB.ended, 200)).toBe(false);

    expect((await fetch(`${base}${a.url}api/diff`)).status).toBe(404);
    expect((await listSessions(base)).map((session) => session.id)).toEqual([b.id]);

    await postComments(`${base}${b.url}api/comments`, [makeThread('b1', 'beta.ts', 'in b')]);
    await vi.waitFor(() =>
      expect(watchB.events).toEqual([
        { type: 'connected' },
        { type: 'commentsChanged', version: 1 },
      ]),
    );
  });

  it('ends its event streams cleanly and leaves no heartbeat timer behind', async () => {
    const { base } = await startApp();
    const a = await openPr(base, PR_A);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const watch = await openEventStream(`${base}${a.url}api/watch`);
    const heartbeat = await openEventStream(`${base}${a.url}api/heartbeat`);
    await vi.waitFor(() => {
      expect(watch.events).toEqual([{ type: 'connected' }]);
      expect(heartbeat.events).toEqual([{ type: 'connected' }]);
    });
    expect(vi.getTimerCount()).toBe(1);

    const response = await deleteSession(base, a.id);

    expect(response.status).toBe(200);
    // `ended` rejects if the connection breaks, so `true` means the server ended the stream.
    expect(await settledWithin(watch.ended, 2000)).toBe(true);
    expect(await settledWithin(heartbeat.ended, 2000)).toBe(true);
    // A timer left running would write to the ended heartbeat response.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers 404 for unknown session ids', async () => {
    const { base } = await startApp();
    await openPr(base, PR_A);

    const response = await deleteSession(base, 'no-such-session');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: expect.any(String) });

    for (const path of ['api/diff', 'api/comments-json', 'api/heartbeat', 'api/watch']) {
      expect((await fetch(`${base}/s/no-such-session/${path}`)).status).toBe(404);
    }
    expect(await listSessions(base)).toHaveLength(1);
  });

  it('answers 409 while the session is still being created, then keeps it', async () => {
    const github = fakeGitHub();
    const releasePatch = holdPatch(github);
    const { base } = await startApp(github);
    // Ids are deterministic, so another server tells the id before this one finishes.
    const { id } = await openPr((await startApp()).base, PR_A);

    const creation = createSession(base, { prUrl: PR_A });
    await vi.waitFor(() => expect(github.getPrPatch).toHaveBeenCalledTimes(1));
    const response = await deleteSession(base, id);
    releasePatch();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect((await creation).status).toBe(201);
    expect((await listSessions(base)).map((session) => session.id)).toEqual([id]);
  });

  it('does not serve session routes outside /s/<id>/', async () => {
    const { base } = await startApp();
    await openPr(base, PR_A);

    for (const path of ['/api/diff', '/api/comments-json', '/api/heartbeat']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
  });
});

describe('heartbeat', () => {
  it('keeps the process and the session when a tab disconnects', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const { base } = await startApp();
    const a = await openPr(base, PR_A);

    const controller = new AbortController();
    const response = await fetch(`${base}${a.url}api/heartbeat`, { signal: controller.signal });
    const { value } = await response.body!.getReader().read();
    expect(new TextDecoder().decode(value)).toBe('data: connected\n\n');
    controller.abort();
    // Single mode exits 100ms after the close; wait well past that.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(exit).not.toHaveBeenCalled();
    expect((await listSessions(base)).map((session) => session.id)).toEqual([a.id]);
    expect((await fetch(`${base}${a.url}api/comments-json`)).status).toBe(200);
  });
});

describe('clean', () => {
  it('asks only the first diff load after creation to clear local comments', async () => {
    const { base } = await startApp();
    const clearCommentsOf = async (url: string) =>
      (await getJson(`${base}${url}api/diff`)).clearComments as boolean | undefined;

    const a = await openPr(base, PR_A, { clean: true });
    expect(await clearCommentsOf(a.url)).toBe(true);
    expect(await clearCommentsOf(a.url)).toBeUndefined();

    // Asking again for an open session does not clear it a second time.
    const again = await createSession(base, { prUrl: PR_A, clean: true });
    expect(again.status).toBe(200);
    expect(await clearCommentsOf(a.url)).toBeUndefined();

    const b = await openPr(base, PR_B);
    expect(await clearCommentsOf(b.url)).toBeUndefined();
  });
});

describe('GET /api/server-info', () => {
  it('identifies a multi-mode difit server and where it saves the PR list', async () => {
    const { base, prsPath } = await startApp();

    expect(await getJson(`${base}/api/server-info`)).toEqual({
      app: 'difit',
      mode: 'multi',
      version: pkg.version,
      pid: process.pid,
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      prList: { path: prsPath },
    });
  });
});

describe('the saved PR list', () => {
  it('saves each opened PR before answering, oldest first, and drops a closed one before answering', async () => {
    const { base, prsPath } = await startApp();

    const b = await openPr(base, PR_B);
    const file = await readPrsFile(prsPath);
    expect(file).toEqual({
      version: 1,
      pullRequests: [{ url: PR_B, addedAt: expect.any(String) }],
    });
    const { addedAt } = file.pullRequests[0];
    expect(new Date(addedAt).toISOString()).toBe(addedAt);

    await openPr(base, PR_A);
    expect(await savedUrls(prsPath)).toEqual([PR_B, PR_A]);

    // Asking again for an open PR changes nothing.
    expect((await createSession(base, { prUrl: PR_A })).status).toBe(200);
    expect(await savedUrls(prsPath)).toEqual([PR_B, PR_A]);

    expect((await deleteSession(base, b.id)).status).toBe(200);
    expect(await savedUrls(prsPath)).toEqual([PR_A]);
  });

  it('does not save a PR that could not be opened', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const github = fakeGitHub();
    github.getPrPatch.mockRejectedValueOnce(new Error('gh pr diff failed'));
    const { base, prsPath } = await startApp(github);

    expect((await createSession(base, { prUrl: PR_A })).status).toBe(502);

    await expect(readFile(prsPath, 'utf8')).rejects.toThrow(/ENOENT/);
    expect(await listSessions(base)).toEqual([]);
  });

  it('writes concurrent opens and closes one at a time, so the file ends with every change', async () => {
    const { base, prsPath } = await startApp();
    const prUrls = [1, 2, 3, 4, 5, 6].map((n) => `https://github.com/octo/repo${n}/pull/${n}`);

    const opened = await Promise.all(prUrls.map((prUrl) => openPr(base, prUrl)));
    expect(new Set(await savedUrls(prsPath))).toEqual(new Set(prUrls));

    const closes = await Promise.all(opened.slice(0, 4).map(({ id }) => deleteSession(base, id)));
    expect(closes.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(await savedUrls(prsPath))).toEqual(new Set(prUrls.slice(4)));
    // No temporary file is left behind next to the list.
    expect(await readdir(join(prsPath, '..'))).toEqual(['prs.json']);
  });
});

describe('a saved PR list the server cannot use', () => {
  it.each([
    ['invalid JSON', '{"version": 1, "pullRequests": ['],
    ['another version', '{"version": 2, "pullRequests": []}'],
    ['another shape', '[{"url": "https://github.com/octo/alpha/pull/1"}]'],
  ])(
    'starts empty, warns in server-info, and never overwrites a file with %s',
    async (_kind, content) => {
      const prsPath = join(await makeTempDir(), 'prs.json');
      await writeFile(prsPath, content);
      const { base, restoreSessions } = await startApp(fakeGitHub(), { prsPath });

      await restoreSessions();
      expect(await listSessions(base)).toEqual([]);
      const info = await getJson(`${base}/api/server-info`);
      expect(info.prList).toEqual({ path: prsPath, warning: expect.stringContaining(prsPath) });

      // PRs still open; they are just not saved.
      const a = await openPr(base, PR_A);
      expect((await deleteSession(base, a.id)).status).toBe(200);
      await openPr(base, PR_B);
      expect(await readFile(prsPath, 'utf8')).toBe(content);
    },
  );

  it('starts empty and warns when the file cannot be read', async () => {
    const prsPath = join(await makeTempDir(), 'prs.json');
    await mkdir(prsPath);
    const { base } = await startApp(fakeGitHub(), { prsPath });

    await openPr(base, PR_A);

    const info = await getJson(`${base}/api/server-info`);
    expect(info.prList).toEqual({ path: prsPath, warning: expect.stringContaining(prsPath) });
    expect(await readdir(prsPath)).toEqual([]);
  });
});

describe('restoring the saved PR list', () => {
  const PR_C = 'https://github.com/octo/gamma/pull/3';
  const GH_FAILURE =
    'Could not fetch the pull request with gh. Check that it exists and that gh is installed and logged in (gh auth status). The server log has the details.';
  const row = (url: string, day: number) => ({
    url,
    addedAt: `2026-01-0${day}T00:00:00.000Z`,
  });

  const statuses = async (base: string) =>
    ((await listSessions(base)) as Array<{ prUrl: string; status: string }>).map(
      ({ prUrl, status }) => [prUrl, status],
    );

  it('lists saved PRs as restoring by when they were added, then opens them one by one', async () => {
    const unreadable = { url: 'https://example.com/octo/alpha/pull/1', addedAt: 'yesterday' };
    const prsPath = await writePrsFile([
      row(PR_B, 2),
      unreadable,
      row(PR_A, 1),
      // The same PR as PR_A in another case: one session, so the later row goes.
      row('https://github.com/Octo/Alpha/pull/1', 3),
    ]);
    const github = fakeGitHub();
    const { base, restoreSessions } = await startApp(github, { prsPath });

    expect(await listSessions(base)).toEqual([
      { id: expect.any(String), status: 'restoring', prUrl: PR_A, label: 'octo/alpha#1' },
      { id: expect.any(String), status: 'restoring', prUrl: PR_B, label: 'octo/beta#2' },
    ]);
    expect(github.getPrSummary).not.toHaveBeenCalled();

    await restoreSessions();

    const sessions = (await listSessions(base)) as Array<{ url: string; title: string }>;
    expect(await statuses(base)).toEqual([
      [PR_A, 'open'],
      [PR_B, 'open'],
    ]);
    expect(sessions.map((session) => session.title)).toEqual([
      `Title of ${PR_A}`,
      `Title of ${PR_B}`,
    ]);
    // One gh pr view per PR gives both its state and its title.
    expect(github.getPrSummary.mock.calls).toEqual([[PR_A], [PR_B]]);
    const diff = await getJson(`${base}${sessions[0]?.url}api/diff`);
    expect(diff.files.map((file: { path: string }) => file.path)).toEqual(['alpha.ts']);
    // The rows the server cannot open stay in the file; the duplicate goes on the next save.
    await openPr(base, PR_C);
    expect((await readPrsFile(prsPath)).pullRequests).toEqual([
      row(PR_A, 1),
      row(PR_B, 2),
      { url: PR_C, addedAt: expect.any(String) },
      unreadable,
    ]);
  });

  it('drops merged and closed PRs from the list and the file without opening them', async () => {
    const prsPath = await writePrsFile([row(PR_A, 1), row(PR_B, 2), row(PR_C, 3)]);
    const github = fakeGitHub();
    const states: Record<string, PullRequestSummary['state']> = {
      [PR_B]: 'MERGED',
      [PR_C]: 'CLOSED',
    };
    github.getPrSummary.mockImplementation(async (prUrl) => ({
      title: undefined,
      state: states[prUrl] ?? 'OPEN',
    }));
    const { base, restoreSessions } = await startApp(github, { prsPath });

    await restoreSessions();

    expect(await statuses(base)).toEqual([[PR_A, 'open']]);
    expect(await savedUrls(prsPath)).toEqual([PR_A]);
    expect(github.getPrPatch.mock.calls).toEqual([[PR_A]]);
  });

  it('keeps a PR gh could not fetch as failed, in the list and the file, and retries it on POST', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prsPath = await writePrsFile([row(PR_A, 1), row(PR_B, 2), row(PR_C, 3)]);
    const github = fakeGitHub();
    github.getPrSummary.mockImplementation(async (prUrl) => {
      if (prUrl === PR_B) {
        throw new Error('HTTP 401: Bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      }
      return { title: undefined, state: 'OPEN' };
    });
    github.getPrPatch.mockImplementation(async (prUrl) => {
      if (prUrl === PR_C) {
        throw new Error('gh pr diff failed');
      }
      return patchFor(fileOf(prUrl));
    });
    const { base, restoreSessions } = await startApp(github, { prsPath });

    await restoreSessions();

    const text = await (await fetch(`${base}/api/sessions`)).text();
    expect(text).not.toContain('ghp_');
    const failedRow = (prUrl: string, label: string) => ({
      id: expect.any(String),
      status: 'failed',
      prUrl,
      label,
      error: GH_FAILURE,
    });
    expect(JSON.parse(text).sessions.slice(1)).toEqual([
      failedRow(PR_B, 'octo/beta#2'),
      failedRow(PR_C, 'octo/gamma#3'),
    ]);
    expect(await savedUrls(prsPath)).toEqual([PR_A, PR_B, PR_C]);
    const logged = consoleError.mock.calls.flat().join('\n');
    expect(logged).toContain('octo/beta#2');
    expect(logged).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');

    github.getPrSummary.mockResolvedValue({ title: undefined, state: 'OPEN' });
    const retried = await createSession(base, { prUrl: PR_B });

    expect(retried.status).toBe(201);
    expect(await statuses(base)).toEqual([
      [PR_A, 'open'],
      [PR_B, 'open'],
      [PR_C, 'failed'],
    ]);
    // A retry keeps the PR's place and the time it was first added.
    expect((await readPrsFile(prsPath)).pullRequests).toEqual([
      row(PR_A, 1),
      row(PR_B, 2),
      row(PR_C, 3),
    ]);
  });

  it('lets DELETE drop a waiting or failed PR, and answers 409 for the one being restored', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const prsPath = await writePrsFile([row(PR_A, 1), row(PR_B, 2), row(PR_C, 3)]);
    const github = fakeGitHub();
    const releaseA = holdSummary(github);
    github.getPrPatch.mockImplementation(async (prUrl) => {
      if (prUrl === PR_C) {
        throw new Error('gh pr diff failed');
      }
      return patchFor(fileOf(prUrl));
    });
    const { base, restoreSessions } = await startApp(github, { prsPath });
    const [a, b, c] = (await listSessions(base)) as Array<{ id: string }>;

    const restoring = restoreSessions();
    await vi.waitFor(() => expect(github.getPrSummary).toHaveBeenCalledTimes(1));

    expect((await deleteSession(base, a!.id)).status).toBe(409);
    const deleteB = await deleteSession(base, b!.id);
    expect(deleteB.status).toBe(200);
    expect(await deleteB.json()).toEqual({ success: true, id: b!.id });
    expect(await savedUrls(prsPath)).toEqual([PR_A, PR_C]);
    expect(await statuses(base)).toEqual([
      [PR_A, 'restoring'],
      [PR_C, 'restoring'],
    ]);

    releaseA();
    await restoring;

    expect(github.getPrSummary.mock.calls).toEqual([[PR_A], [PR_C]]);
    expect(await statuses(base)).toEqual([
      [PR_A, 'open'],
      [PR_C, 'failed'],
    ]);
    expect((await deleteSession(base, c!.id)).status).toBe(200);
    expect(await statuses(base)).toEqual([[PR_A, 'open']]);
    expect(await savedUrls(prsPath)).toEqual([PR_A]);
  });

  it('opens a waiting PR at once on POST instead of waiting for its turn', async () => {
    const prsPath = await writePrsFile([row(PR_A, 1), row(PR_B, 2)]);
    const github = fakeGitHub();
    const releaseA = holdSummary(github);
    const { base, restoreSessions } = await startApp(github, { prsPath });

    const restoring = restoreSessions();
    await vi.waitFor(() => expect(github.getPrSummary).toHaveBeenCalledTimes(1));
    const b = await createSession(base, { prUrl: PR_B });

    expect(b.status).toBe(201);
    expect(await statuses(base)).toEqual([
      [PR_A, 'restoring'],
      [PR_B, 'open'],
    ]);

    releaseA();
    await restoring;

    expect(await statuses(base)).toEqual([
      [PR_A, 'open'],
      [PR_B, 'open'],
    ]);
    expect(github.getPrPatch.mock.calls.filter(([prUrl]) => prUrl === PR_B)).toHaveLength(1);
    expect(await savedUrls(prsPath)).toEqual([PR_A, PR_B]);
  });

  it('opens a PR asked for by POST even when its restore finds it merged', async () => {
    const prsPath = await writePrsFile([row(PR_A, 1)]);
    const github = fakeGitHub();
    const releaseA = holdSummary(github);
    const { base, restoreSessions } = await startApp(github, { prsPath });

    const restoring = restoreSessions();
    await vi.waitFor(() => expect(github.getPrSummary).toHaveBeenCalledTimes(1));
    const creation = createSession(base, { prUrl: PR_A });
    // Let the POST reach the server while the restore is still asking gh.
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseA('MERGED');
    await restoring;

    expect((await creation).status).toBe(201);
    expect(await statuses(base)).toEqual([[PR_A, 'open']]);
    expect(await savedUrls(prsPath)).toEqual([PR_A]);
  });
});

describe('request guards', () => {
  it('rejects requests whose Host is not a loopback name on this port', async () => {
    const { base, port, github } = await startApp();
    const a = await openPr(base, PR_A);
    const body = JSON.stringify({ prUrl: PR_B });

    for (const host of ['evil.example', `evil.example:${port}`, `localhost:${port + 1}`]) {
      const post = await rawRequest(port, {
        method: 'POST',
        path: '/api/sessions',
        headers: { Host: host, 'Content-Type': 'application/json' },
        body,
      });
      expect(post.status).toBe(403);
      for (const path of ['/api/sessions', '/api/server-info', `${a.url}api/comments-json`]) {
        expect(
          (await rawRequest(port, { method: 'GET', path, headers: { Host: host } })).status,
        ).toBe(403);
      }
    }
    expect(github.getPrPatch).toHaveBeenCalledTimes(1);

    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      const list = await rawRequest(port, {
        method: 'GET',
        path: '/api/sessions',
        headers: { Host: host },
      });
      expect(list.status).toBe(200);
    }
  });

  it('rejects requests from another origin, reads included', async () => {
    const { base, port, github } = await startApp();
    const a = await openPr(base, PR_A);
    const host = `127.0.0.1:${port}`;

    for (const origin of ['http://evil.example', `http://localhost:${port + 1}`, 'null']) {
      // The watch and heartbeat routes send Access-Control-Allow-Origin: *, so a
      // foreign page could read them with EventSource if the request got through.
      for (const path of [
        '/api/sessions',
        '/api/server-info',
        `${a.url}api/watch`,
        `${a.url}api/heartbeat`,
        `${a.url}api/comments-json`,
      ]) {
        const read = await rawRequest(port, {
          method: 'GET',
          path,
          headers: { Host: host, Origin: origin },
        });
        expect(read.status).toBe(403);
      }
      const headers = { Host: host, Origin: origin, 'Content-Type': 'application/json' };
      const post = await rawRequest(port, {
        method: 'POST',
        path: '/api/sessions',
        headers,
        body: JSON.stringify({ prUrl: PR_B }),
      });
      expect(post.status).toBe(403);
      const del = await rawRequest(port, {
        method: 'DELETE',
        path: `/api/sessions/${a.id}`,
        headers,
      });
      expect(del.status).toBe(403);
      const comment = await rawRequest(port, {
        method: 'POST',
        path: `${a.url}api/comments`,
        headers,
        body: JSON.stringify({ threads: [makeThread('x', 'alpha.ts', 'forged')] }),
      });
      expect(comment.status).toBe(403);
    }
    expect(github.getPrPatch).toHaveBeenCalledTimes(1);
    expect(await getJson(`${base}${a.url}api/comments-json`)).toEqual({ version: 0, threads: [] });

    const sameOrigin = await rawRequest(port, {
      method: 'POST',
      path: '/api/sessions',
      headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prUrl: PR_B }),
    });
    expect(sameOrigin.status).toBe(201);
    const sameOriginRead = await rawRequest(port, {
      method: 'GET',
      path: '/api/sessions',
      headers: { Host: host, Origin: `http://${host}` },
    });
    expect(sameOriginRead.status).toBe(200);
  });

  it('lets the session list page close a session with a bodiless DELETE', async () => {
    const { base, port } = await startApp();
    const a = await openPr(base, PR_A);
    const host = `127.0.0.1:${port}`;

    // What a browser sends for the list page's fetch: its own Origin, and the
    // Content-Type the page sets, with no body.
    const del = await rawRequest(port, {
      method: 'DELETE',
      path: `/api/sessions/${a.id}`,
      headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json' },
    });

    expect(del.status).toBe(200);
    expect(JSON.parse(del.body)).toEqual({ success: true, id: a.id });
    expect(await listSessions(base)).toEqual([]);
  });

  it('requires a JSON content type on session writes', async () => {
    const { base, github } = await startApp();
    const a = await openPr(base, PR_A);

    const textPost = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ prUrl: PR_B }),
    });
    expect(textPost.status).toBe(415);

    const formPost = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `prUrl=${encodeURIComponent(PR_B)}`,
    });
    expect(formPost.status).toBe(415);

    const bareDelete = await fetch(`${base}/api/sessions/${a.id}`, { method: 'DELETE' });
    expect(bareDelete.status).toBe(415);

    expect(github.getPrPatch).toHaveBeenCalledTimes(1);
    expect(await listSessions(base)).toHaveLength(1);
  });

  it('rejects malformed and oversized JSON bodies', async () => {
    const { base, github } = await startApp();

    const malformed = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{"prUrl":',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: expect.any(String) });

    const oversized = await createSession(base, {
      prUrl: PR_A,
      padding: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: expect.any(String) });

    expect(github.getPrPatch).not.toHaveBeenCalled();
  });

  it('adds no CORS headers of its own to the sessions API', async () => {
    const { base, port } = await startApp();

    const created = await createSession(base, { prUrl: PR_A });
    expect(created.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await rawRequest(port, {
      method: 'OPTIONS',
      path: '/api/sessions',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'http://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('review pages', () => {
  const INDEX_HTML =
    '<!doctype html><div id="root"></div><script type="module" src="/assets/index.js"></script>';
  let clientDir = '';

  beforeEach(async () => {
    clientDir = await mkdtemp(join(tmpdir(), 'difit-client-'));
    await mkdir(join(clientDir, 'assets'));
    await writeFile(join(clientDir, 'index.html'), INDEX_HTML);
    await writeFile(join(clientDir, 'assets', 'index.js'), 'export {};');
  });

  afterEach(async () => {
    await rm(clientDir, { recursive: true, force: true });
  });

  it('serves the client page at /s/<id> and /s/<id>/', async () => {
    const { base } = await startApp(fakeGitHub(), { clientDir });
    const { id, url } = await openPr(base, PR_A);
    expect(url).toMatch(SESSION_PATH_PATTERN);

    for (const path of [`/s/${id}`, url]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^text\/html/);
      expect(await response.text()).toBe(INDEX_HTML);
    }
  });

  it('serves the client page at /, where it lists the open PRs', async () => {
    const { base } = await startApp(fakeGitHub(), { clientDir });

    const response = await fetch(`${base}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it('serves the client from under a dot directory, as with npx in ~/.npm', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'difit-dot-'));
    try {
      const hiddenClientDir = join(parent, '.hidden-dir', 'client');
      await mkdir(join(hiddenClientDir, 'assets'), { recursive: true });
      await writeFile(join(hiddenClientDir, 'index.html'), INDEX_HTML);
      await writeFile(join(hiddenClientDir, 'assets', 'index.js'), 'export {};');
      const { base } = await startApp(fakeGitHub(), { clientDir: hiddenClientDir });
      const { id, url } = await openPr(base, PR_A);

      for (const path of [`/s/${id}`, url]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(INDEX_HTML);
      }
      const asset = await fetch(`${base}/assets/index.js`);
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe('export {};');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('serves the client assets from the root, where the page refers to them', async () => {
    const { base } = await startApp(fakeGitHub(), { clientDir });

    const response = await fetch(`${base}/assets/index.js`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('export {};');
  });

  it('serves no page for an unknown session', async () => {
    const { base } = await startApp(fakeGitHub(), { clientDir });

    const response = await fetch(`${base}/s/0123456789abcdef/`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Unknown session' });
  });

  it('answers 500 with JSON when the client is not built', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await rm(join(clientDir, 'index.html'));
    const { base } = await startApp(fakeGitHub(), { clientDir });
    const { url } = await openPr(base, PR_A);

    const response = await fetch(`${base}${url}`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('index.html'));
  });
});

describe('startMultiServer', () => {
  it('listens on a loopback host and refuses to bind anywhere else', async () => {
    const github = fakeGitHub();
    const prList = await openPrList(join(await makeTempDir(), 'prs.json'));

    await expect(startMultiServer({ github, prList, host: '0.0.0.0' })).rejects.toThrow(
      /loopback/,
    );

    const started = await startMultiServer({
      github,
      prList,
      preferredPort: 9410,
      host: '127.0.0.1',
    });
    openServers.push(started.server);
    expect(started.url).toBe(`http://127.0.0.1:${started.port}`);
    expect(await getJson(`${started.url}/api/server-info`)).toMatchObject({ mode: 'multi' });
  });
});
