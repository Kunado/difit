import { request as httpRequest, type Server } from 'http';
import { type AddressInfo } from 'net';

import { fetch } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';

import pkg from '../../package.json' with { type: 'json' };
import { getPrCommentImports, getPrPatch, getPrTitle } from '../cli/github.js';
import { type CommentImport } from '../types/diff.js';

import { createMultiSessionApp, type PullRequestSource, startMultiServer } from './multi-server.js';

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
  vi.restoreAllMocks();
});

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
    getPrTitle: vi.fn(async (prUrl: string): Promise<string | undefined> => `Title of ${prUrl}`),
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

async function startApp(github: PullRequestSource = fakeGitHub()) {
  const app = createMultiSessionApp({ github });
  const server = app.listen(0, '127.0.0.1');
  openServers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, port, github };
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
    github.getPrTitle.mockRejectedValue(new Error('gh pr view failed'));
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
});

describe('a gh run that never exits', () => {
  const ghSource: PullRequestSource = { getPrPatch, getPrCommentImports, getPrTitle };

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
          ? JSON.stringify({ title: 'Alpha' })
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

    expect((await deleteSession(base, id)).status).toBe(404);
    const response = await creation;
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
  it('identifies a multi-mode difit server', async () => {
    const { base } = await startApp();

    expect(await getJson(`${base}/api/server-info`)).toEqual({
      app: 'difit',
      mode: 'multi',
      version: pkg.version,
      pid: process.pid,
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
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

describe('startMultiServer', () => {
  it('listens on a loopback host and refuses to bind anywhere else', async () => {
    const github = fakeGitHub();

    await expect(startMultiServer({ github, host: '0.0.0.0' })).rejects.toThrow(/loopback/);

    const started = await startMultiServer({ github, preferredPort: 9410, host: '127.0.0.1' });
    openServers.push(started.server);
    expect(started.url).toBe(`http://127.0.0.1:${started.port}`);
    expect(await getJson(`${started.url}/api/server-info`)).toMatchObject({ mode: 'multi' });
  });
});
