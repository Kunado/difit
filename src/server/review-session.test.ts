import { type Server } from 'http';
import { type AddressInfo } from 'net';

import express from 'express';
import { fetch } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReviewSession, type ReviewSession, startServer } from './server.js';

// Copied from server.test.ts so that file stays untouched.
vi.mock('./git-diff.js', () => {
  class GitDiffParserMock {
    validateCommit = vi.fn().mockResolvedValue(true);
    parseDiff = vi.fn().mockResolvedValue({
      targetCommit: 'abc123',
      baseCommit: 'def456',
      baseCommitish: 'def4567',
      targetCommitish: 'abc1234',
      requestedBaseCommitish: 'HEAD^',
      requestedTargetCommitish: 'HEAD',
      requestedBaseMode: undefined,
      targetMessage: 'Test commit',
      baseMessage: 'Previous commit',
      files: [
        {
          path: 'test.js',
          additions: 10,
          deletions: 5,
          chunks: [],
        },
      ],
      stats: { additions: 10, deletions: 5 },
      isEmpty: false,
    });
    parseStdinDiff = vi.fn().mockReturnValue({
      targetCommit: 'stdin-target',
      baseCommit: 'stdin-base',
      targetMessage: 'stdin target',
      baseMessage: 'stdin base',
      files: [
        {
          path: 'stdin-test.js',
          additions: 1,
          deletions: 0,
          chunks: [],
        },
      ],
      stats: { additions: 1, deletions: 0 },
      isEmpty: false,
    });
    getBlobContent = vi.fn().mockResolvedValue(Buffer.from('mock image data'));
    getLineCount = vi.fn().mockResolvedValue(42);
    getGeneratedStatus = vi.fn().mockResolvedValue({
      isGenerated: true,
      source: 'content',
    });
    clearResolvedCommitCache = vi.fn();
    getRevisionOptions = vi.fn().mockResolvedValue({
      branches: [{ name: 'main', current: true }],
      commits: [{ hash: 'abc1234', shortHash: 'abc1234', message: 'Test commit' }],
      originDefaultBranch: 'origin/main',
      resolvedBase: 'abc1234',
      resolvedTarget: 'def5678',
    });
  }

  return { GitDiffParser: GitDiffParserMock };
});

type ReviewSessionHooks = Parameters<typeof createReviewSession>[1];

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

// Mounts sessions "a" and "b" behind one /s/:id dispatcher, the way a multi-session
// server would, with a catch-all after it to show where unmatched requests end up.
async function mountTwoSessions(hooks: { a?: ReviewSessionHooks; b?: ReviewSessionHooks } = {}) {
  const sessions = new Map<string, ReviewSession>([
    [
      'a',
      await createReviewSession(
        { selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' } },
        hooks.a ?? { onHeartbeatClose: vi.fn() },
      ),
    ],
    [
      'b',
      await createReviewSession(
        { selection: { baseCommitish: 'main', targetCommitish: 'feature-b' } },
        hooks.b ?? { onHeartbeatClose: vi.fn() },
      ),
    ],
  ]);

  const app = express();
  app.use(express.json());
  app.use(express.text());
  app.use('/s/:id', (req, res, next) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    session.router(req, res, next);
  });
  app.use((req, res) => {
    res.status(404).json({ fellThrough: req.originalUrl, url: req.url });
  });

  const server = app.listen(0, '127.0.0.1');
  openServers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, sessions };
}

const isoNow = '2024-01-01T00:00:00Z';
const makeThread = (id: string, filePath: string, line: number, body: string) => ({
  id,
  filePath,
  createdAt: isoNow,
  updatedAt: isoNow,
  position: { side: 'new' as const, line },
  messages: [{ id, body, createdAt: isoNow, updatedAt: isoNow }],
});

const postJson = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const getJson = async (url: string) => (await fetch(url)).json() as Promise<any>;

async function optionsOf(url: string) {
  const response = await fetch(url, { method: 'OPTIONS' });
  return {
    status: response.status,
    allow: response.headers.get('allow'),
    body: await response.text(),
  };
}

async function openAndCloseHeartbeat(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const { value } = await response.body!.getReader().read();
  expect(new TextDecoder().decode(value)).toBe('data: connected\n\n');
  controller.abort();
}

async function openEventStream(url: string) {
  const controller = new AbortController();
  openStreams.push(controller);
  const response = await fetch(url, { signal: controller.signal });
  const events: Array<{ type: string; version?: number }> = [];
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for await (const chunk of response.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          const { type, version } = JSON.parse(buffer.slice('data: '.length, end));
          events.push({ type, version });
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Aborted in afterEach.
    }
  })();
  return events;
}

// Collects a stream's raw text and records when the server ends it.
async function openRawStream(url: string) {
  const controller = new AbortController();
  openStreams.push(controller);
  const response = await fetch(url, { signal: controller.signal });
  const stream = { text: '', ended: false };
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of response.body!) {
        stream.text += decoder.decode(chunk, { stream: true });
      }
      stream.ended = true;
    } catch {
      // Aborted in afterEach.
    }
  })();
  return stream;
}

describe('two review sessions mounted on one app', () => {
  it('keeps comments separate per session', async () => {
    const { base } = await mountTwoSessions();

    const response = await postJson(`${base}/s/a/api/comments`, {
      threads: [makeThread('a1', 'src/a.ts', 3, 'only in a')],
    });
    expect(response.status).toBe(200);

    expect(await getJson(`${base}/s/a/api/comments-json`)).toMatchObject({
      version: 1,
      threads: [{ id: 'a1' }],
    });
    expect(await getJson(`${base}/s/b/api/comments-json`)).toEqual({ version: 0, threads: [] });
    expect(await (await fetch(`${base}/s/a/api/comments-output`)).text()).toContain('only in a');
    expect(await (await fetch(`${base}/s/b/api/comments-output`)).text()).toBe('');
  });

  it('keeps the current selection separate per session', async () => {
    const { base } = await mountTwoSessions();
    // Without ?ref, generated-status reports the session's current target.
    const currentTarget = async (id: string) =>
      (await getJson(`${base}/s/${id}/api/generated-status/src/a.ts`)).ref;

    expect(await currentTarget('a')).toBe('HEAD');
    expect(await currentTarget('b')).toBe('feature-b');

    await fetch(`${base}/s/a/api/diff?base=main&target=feature-a`);

    expect(await currentTarget('a')).toBe('feature-a');
    expect(await currentTarget('b')).toBe('feature-b');
  });

  it('captures regex route paths below the mount point', async () => {
    const { base } = await mountTwoSessions();

    expect(await getJson(`${base}/s/a/api/generated-status/src/deep/file.ts?ref=HEAD`)).toEqual({
      path: 'src/deep/file.ts',
      ref: 'HEAD',
      isGenerated: true,
      source: 'content',
    });
    expect(await getJson(`${base}/s/b/api/line-count/src/deep/file.ts?newRef=HEAD`)).toEqual({
      newLineCount: 42,
    });

    const blob = await fetch(`${base}/s/a/api/blob/img/logo.png?ref=HEAD`);
    expect(blob.headers.get('content-type')).toBe('image/png');
    expect(await blob.text()).toBe('mock image data');
  });

  it('passes unmatched requests on to the next handler with the URL restored', async () => {
    const { base } = await mountTwoSessions();

    const unknownPath = await fetch(`${base}/s/a/not-a-route`);
    expect(unknownPath.status).toBe(404);
    expect(await unknownPath.json()).toEqual({
      fellThrough: '/s/a/not-a-route',
      url: '/s/a/not-a-route',
    });

    const wrongMethod = await fetch(`${base}/s/b/api/diff`, { method: 'POST' });
    expect(wrongMethod.status).toBe(404);
    expect(await wrongMethod.json()).toEqual({
      fellThrough: '/s/b/api/diff',
      url: '/s/b/api/diff',
    });

    const unknownSession = await fetch(`${base}/s/zzz/api/diff`);
    expect(unknownSession.status).toBe(404);
    expect(await unknownSession.json()).toEqual({ error: 'Unknown session' });
  });

  it('answers OPTIONS under the mount point the same way as single mode', async () => {
    const cases = [
      ['/api/diff', 'GET, HEAD'],
      ['/api/comments', 'POST'],
      ['/api/comments/t1', 'DELETE'],
      ['/api/blob/img/logo.png', 'GET, HEAD'],
      ['/api/user-settings', 'GET, HEAD, PUT'],
    ] as const;

    const single = await startServer({
      selection: { baseCommitish: 'HEAD^', targetCommitish: 'HEAD' },
      preferredPort: 9400,
      host: '127.0.0.1',
      openBrowser: false,
    });
    openServers.push(single.server!);
    for (const [path, allow] of cases) {
      expect(await optionsOf(`${single.url}${path}`)).toEqual({ status: 200, allow, body: allow });
    }
    expect(await optionsOf(`${single.url}/not-a-route`)).toMatchObject({
      status: 404,
      allow: null,
    });

    const { base } = await mountTwoSessions();
    for (const [path, allow] of cases) {
      expect(await optionsOf(`${base}/s/a${path}`)).toEqual({ status: 200, allow, body: allow });
    }
    expect(await optionsOf(`${base}/s/a/not-a-route`)).toMatchObject({ status: 404, allow: null });
  });

  it('calls the heartbeat hook of the closed session only', async () => {
    const hooks = { a: { onHeartbeatClose: vi.fn() }, b: { onHeartbeatClose: vi.fn() } };
    const { base, sessions } = await mountTwoSessions(hooks);

    await openAndCloseHeartbeat(`${base}/s/a/api/heartbeat`);

    await vi.waitFor(() => expect(hooks.a.onHeartbeatClose).toHaveBeenCalledTimes(1));
    expect(hooks.a.onHeartbeatClose).toHaveBeenCalledWith(sessions.get('a'));
    expect(hooks.b.onHeartbeatClose).not.toHaveBeenCalled();
  });

  it('keeps serving after a heartbeat closes when the hook does nothing', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const onHeartbeatClose = vi.fn();
    const { base } = await mountTwoSessions({ a: { onHeartbeatClose } });

    await openAndCloseHeartbeat(`${base}/s/a/api/heartbeat`);
    await vi.waitFor(() => expect(onHeartbeatClose).toHaveBeenCalledTimes(1));
    // startServer's hook exits 100ms after the close; wait well past that.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(exit).not.toHaveBeenCalled();
    expect((await fetch(`${base}/s/a/api/comments-json`)).status).toBe(200);
  });

  it('keeps watch streams and commentsChanged events per session', async () => {
    const { base } = await mountTwoSessions();
    const eventsA = await openEventStream(`${base}/s/a/api/watch`);
    const eventsB = await openEventStream(`${base}/s/b/api/watch`);
    await vi.waitFor(() => {
      expect(eventsA).toEqual([{ type: 'connected' }]);
      expect(eventsB).toEqual([{ type: 'connected' }]);
    });

    const a1 = makeThread('a1', 'src/a.ts', 1, 'first in a');
    await postJson(`${base}/s/a/api/comments`, { threads: [a1] });
    await postJson(`${base}/s/a/api/comments`, {
      threads: [a1, makeThread('a2', 'src/a.ts', 2, 'second in a')],
    });
    await postJson(`${base}/s/b/api/comments`, {
      threads: [makeThread('b1', 'src/b.ts', 1, 'only in b')],
    });

    // Events from "a" would reach "b" before b's own event, so b must see exactly one.
    await vi.waitFor(() => {
      expect(eventsA).toEqual([
        { type: 'connected' },
        { type: 'commentsChanged', version: 1 },
        { type: 'commentsChanged', version: 2 },
      ]);
      expect(eventsB).toEqual([{ type: 'connected' }, { type: 'commentsChanged', version: 1 }]);
    });
  });
});

describe('ReviewSession.dispose', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends open heartbeat and watch streams and leaves no heartbeat timer', async () => {
    const onHeartbeatClose = vi.fn();
    const { base, sessions } = await mountTwoSessions({ a: { onHeartbeatClose } });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const heartbeat = await openRawStream(`${base}/s/a/api/heartbeat`);
    const watch = await openRawStream(`${base}/s/a/api/watch`);
    await vi.waitFor(() => {
      expect(heartbeat.text).toBe('data: connected\n\n');
      expect(watch.text).toContain('"type":"connected"');
    });
    expect(vi.getTimerCount()).toBe(1);

    await sessions.get('a')!.dispose();

    await vi.waitFor(() => {
      expect(heartbeat.ended).toBe(true);
      expect(watch.ended).toBe(true);
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(heartbeat.text).toBe('data: connected\n\n');
    // dispose() closed the streams; no tab went away.
    expect(onHeartbeatClose).not.toHaveBeenCalled();
  });
});
