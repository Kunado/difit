// The multi-session server: one process, one port, one review session per GitHub PR,
// each mounted under /s/<id>/. Kept out of server.ts so the VS Code extension, which
// bundles server.ts, does not ship it.
import { type Server } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import pkg from '../../package.json' with { type: 'json' };
import { type CommentImport } from '../types/diff.js';
import { normalizeCommentImports } from '../utils/commentImports.js';

import { type PrList, type ReviewState, type SavedPullRequest } from './pr-list.js';
import {
  identifySession,
  labelOf,
  parsePullRequestUrl,
  type PullRequestRef,
} from './pull-request-url.js';
import { createReviewSession, type ReviewSession, startServerWithFallback } from './server.js';

/** What gh pr view says about a pull request. */
export interface PullRequestSummary {
  title: string | undefined;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

/** Reads a pull request from GitHub. The CLI passes its gh-backed functions. */
export interface PullRequestSource {
  getPrPatch(prUrl: string): Promise<string>;
  getPrCommentImports(prUrl: string): Promise<CommentImport[]>;
  getPrSummary(prUrl: string): Promise<PullRequestSummary>;
}

interface CreateSessionRequest {
  pr: PullRequestRef;
  commentImports: CommentImport[];
  clean: boolean;
}

interface SessionEntry {
  readonly id: string;
  readonly prUrl: string;
  readonly label: string;
  readonly title: string | undefined;
  readonly createdAt: string;
  readonly repositoryId: string;
  readonly session: ReviewSession;
  /** Set by `clean`; consumed by the first /api/diff response. */
  pendingClean: boolean;
}

const PR_URL_ERROR =
  'prUrl must be a URL of the form https://github.com/<owner>/<repo>/pull/<number>';
const GH_FAILURE_ERROR =
  'Could not fetch the pull request with gh. Check that it exists and that gh is installed and logged in (gh auth status). The server log has the details.';
const OPEN_FAILURE_ERROR = 'Failed to open the session';

const MAX_BODY_SIZE = '1mb';
const DEFAULT_CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'client');
const LOOPBACK_HOST_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const LISTEN_HOSTS = new Set(['localhost', '127.0.0.1']);
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g;

/** gh could not read the PR. The message is safe to log, not to return. */
class PullRequestFetchError extends Error {}

// The fixed text a failed open answers with and a failed restore lists; gh's own message
// stays in the server log.
const failureMessage = (error: unknown) =>
  error instanceof PullRequestFetchError ? GH_FAILURE_ERROR : OPEN_FAILURE_ERROR;

function parseCreateSessionRequest(
  body: unknown,
): { ok: true; value: CreateSessionRequest } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const { prUrl, commentImports, clean } = body as Record<string, unknown>;

  const pr = parsePullRequestUrl(prUrl);
  if (!pr) {
    return { ok: false, error: PR_URL_ERROR };
  }
  if (clean !== undefined && typeof clean !== 'boolean') {
    return { ok: false, error: 'clean must be a boolean' };
  }
  try {
    return {
      ok: true,
      value: {
        pr,
        commentImports: commentImports === undefined ? [] : normalizeCommentImports(commentImports),
        clean: clean === true,
      },
    };
  } catch (error) {
    return { ok: false, error: `Invalid commentImports: ${describeError(error)}` };
  }
}

// A review mark is set to done, or back to none. Acknowledging has its own route.
function parseReviewRequest(body: unknown): 'done' | 'none' | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const { state } = body as Record<string, unknown>;
  return state === 'done' || state === 'none' ? state : null;
}

const maskTokens = (text: string) => text.replace(GITHUB_TOKEN_PATTERN, '[redacted]');

// gh's messages help in the server log but could echo a token, so mask token shapes.
function describeError(error: unknown): string {
  return maskTokens(error instanceof Error ? error.message : String(error));
}

// For an unexpected failure the stack locates the bug. It starts with the message, so it
// gets the same mask.
function describeErrorWithStack(error: unknown): string {
  return error instanceof Error && error.stack ? maskTokens(error.stack) : describeError(error);
}

const toSessionInfo = (entry: SessionEntry, review: ReviewState) => ({
  id: entry.id,
  status: 'open' as const,
  url: `/s/${entry.id}/`,
  prUrl: entry.prUrl,
  label: entry.label,
  title: entry.title,
  createdAt: entry.createdAt,
  review,
  commentCount: entry.session.commentCount,
});

// A saved PR without a session yet: it has no page, so no url, and no comments to count.
const toPendingInfo = ({ id, pr, review }: SavedPullRequest, error: string | undefined) => {
  const row = { id, prUrl: pr.url, label: labelOf(pr), review };
  return error === undefined
    ? { ...row, status: 'restoring' as const }
    : { ...row, status: 'failed' as const, error };
};

// Blocks DNS rebinding (a foreign Host) and requests from other sites (a foreign Origin).
// Reads are covered too: the watch and heartbeat routes send Access-Control-Allow-Origin: *,
// and session routes expose PR contents. Same-origin pages and non-browser clients pass.
function guardRequest(req: Request, res: Response, next: NextFunction): void {
  const { host, origin } = req.headers;
  const port = req.socket.localPort;
  if (!LOOPBACK_HOST_NAMES.some((name) => host === `${name}:${port}`)) {
    res.status(403).json({ error: 'Host not allowed' });
    return;
  }
  if (origin !== undefined && origin !== `http://${host}`) {
    res.status(403).json({ error: 'Cross-origin request not allowed' });
    return;
  }
  next();
}

// A cross-site form can send text/plain or urlencoded bodies without a preflight;
// it cannot send application/json.
function requireJsonContentType(req: Request, res: Response, next: NextFunction): void {
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    res.status(415).json({ error: 'Content-Type must be application/json' });
    return;
  }
  next();
}

// Body parser failures become JSON instead of Express's HTML page, which carries a
// stack trace outside production.
function handleError(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res
      .status(status)
      .json({ error: status === 413 ? 'Request body too large' : 'Invalid request body' });
    return;
  }
  console.error(`Unexpected error in the multi-session server: ${describeErrorWithStack(error)}`);
  res.status(500).json({ error: 'Internal server error' });
}

// The browser drops its saved comments and viewed marks each time /api/diff says
// clearComments (App.tsx). A session outlives page loads, so `clean` is said once.
function announceCleanOnce(entry: SessionEntry, res: Response): void {
  const sendJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (!entry.pendingClean || res.statusCode !== 200) {
      return sendJson(body);
    }
    entry.pendingClean = false;
    return sendJson({ ...(body as object), clearComments: true });
  };
}

// The one client page: the session list at /, a review page at /s/<id>/.
function sendClientPage(clientDir: string, res: Response): void {
  const indexPath = join(clientDir, 'index.html');
  // With `root`, send's default dotfiles: 'ignore' checks only the path below clientDir,
  // not dot directories above it such as ~/.npm/_npx/.
  res.sendFile('index.html', { root: clientDir }, (error) => {
    if (error && !res.headersSent) {
      console.error(`Could not serve ${indexPath}: ${describeError(error)}`);
      res.status(500).json({ error: 'Could not serve the client page' });
    }
  });
}

/**
 * The multi-session app and the restore of the PRs its list saved. Every saved PR is
 * listed as restoring until restoreSessions reaches it.
 */
export function createMultiSessionApp({
  github,
  prList,
  clientDir = DEFAULT_CLIENT_DIR,
}: {
  github: PullRequestSource;
  prList: PrList;
  clientDir?: string;
}): { app: Express; restoreSessions: () => Promise<void> } {
  const startedAt = new Date().toISOString();
  // Every saved PR is in exactly one of: sessions (open), creating (being opened or
  // restored), queued (waiting for its restore), failed. GET /api/sessions lists them in
  // prList order. A PR being opened for the first time is in creating only.
  const sessions = new Map<string, SessionEntry>();
  // Creations still running, so concurrent requests for one PR share them. A restore
  // resolves to null when it finds the PR merged or closed.
  const creating = new Map<string, Promise<SessionEntry | null>>();
  const queued = new Set(prList.list().map(({ id }) => id));
  // The fixed error text of each saved PR whose restore or retry failed.
  const failed = new Map<string, string>();

  async function createEntry(
    id: string,
    repositoryId: string,
    { pr, commentImports, clean }: CreateSessionRequest,
    titleRequest: Promise<string | undefined>,
  ): Promise<SessionEntry> {
    const label = labelOf(pr);
    const [patch, prCommentImports, title] = await Promise.all([
      github.getPrPatch(pr.url).catch((error: unknown) => {
        throw new PullRequestFetchError(describeError(error));
      }),
      // Like `difit --pr`, a PR without its review comments is still worth opening.
      github.getPrCommentImports(pr.url).catch((error: unknown) => {
        console.warn(
          `Warning: Failed to load PR review comments for ${label}: ${describeError(error)}`,
        );
        return [];
      }),
      titleRequest,
    ]);
    const session = await createReviewSession(
      { stdinDiff: patch, commentImports: [...prCommentImports, ...commentImports], repositoryId },
      // A closed tab ends neither the process nor the session; DELETE does.
      { onHeartbeatClose: () => {} },
    );
    return {
      id,
      prUrl: pr.url,
      label,
      title,
      createdAt: new Date().toISOString(),
      repositoryId,
      session,
      pendingClean: clean,
    };
  }

  // An open session keeps its state; only the request's commentImports are added to it.
  // `clean` applies at creation only.
  function reuseSession(entry: SessionEntry, request: CreateSessionRequest) {
    if (request.commentImports.length > 0) {
      entry.session.importComments(request.commentImports);
    }
    return { entry, created: false };
  }

  // Runs one creation of the PR's session. A created session is saved to the list before
  // the creation settles; a saved PR whose creation fails is listed as failed.
  function track<T extends SessionEntry | null>(
    pr: PullRequestRef,
    id: string,
    create: () => Promise<T>,
  ): Promise<T> {
    queued.delete(id);
    failed.delete(id);
    const creation = create()
      .then(
        async (entry) => {
          if (entry) {
            sessions.set(id, entry);
            await prList.add(pr);
          }
          return entry;
        },
        (error: unknown) => {
          if (prList.has(id)) {
            failed.set(id, failureMessage(error));
          }
          throw error;
        },
      )
      .finally(() => creating.delete(id));
    creating.set(id, creation);
    return creation;
  }

  async function openSession(
    request: CreateSessionRequest,
  ): Promise<{ entry: SessionEntry; created: boolean }> {
    const { id, repositoryId } = identifySession(request.pr);
    const existing = sessions.get(id);
    if (existing) {
      return reuseSession(existing, request);
    }
    const pending = creating.get(id);
    if (pending) {
      const entry = await pending;
      // A restore that found the PR merged or closed opened nothing; this request still
      // asks for it.
      return entry ? reuseSession(entry, request) : openSession(request);
    }

    // Like `difit --pr`, a PR without its title is still worth opening.
    const title = github.getPrSummary(request.pr.url).then(
      (summary) => summary.title,
      () => undefined,
    );
    const entry = await track(request.pr, id, () => createEntry(id, repositoryId, request, title));
    return { entry, created: true };
  }

  // One gh pr view tells whether the PR is still open and gives its title.
  async function restoreEntry({ id, pr }: SavedPullRequest): Promise<SessionEntry | null> {
    const summary = await github.getPrSummary(pr.url).catch((error: unknown) => {
      throw new PullRequestFetchError(describeError(error));
    });
    if (summary.state !== 'OPEN') {
      console.log(`Removed ${labelOf(pr)} from the PR list: it is ${summary.state.toLowerCase()}`);
      await prList.remove(id);
      return null;
    }
    return createEntry(
      id,
      identifySession(pr).repositoryId,
      { pr, commentImports: [], clean: false },
      Promise.resolve(summary.title),
    );
  }

  // One PR at a time, oldest first. A PR opened, closed, or retried meanwhile has left
  // the queue, and a Set's iteration skips entries deleted before it reaches them.
  async function restoreSessions(): Promise<void> {
    for (const id of queued) {
      const saved = prList.get(id);
      if (!saved) {
        queued.delete(id);
        continue;
      }
      try {
        await track(saved.pr, id, () => restoreEntry(saved));
      } catch (error) {
        const reason =
          error instanceof PullRequestFetchError
            ? `gh failed: ${error.message}`
            : describeErrorWithStack(error);
        console.error(`Failed to restore ${labelOf(saved.pr)}: ${reason}`);
      }
    }
  }

  const describeSaved = (saved: SavedPullRequest) => {
    const entry = sessions.get(saved.id);
    return entry ? toSessionInfo(entry, saved.review) : toPendingInfo(saved, failed.get(saved.id));
  };

  // An open session is always saved: it is added to the list before its creation settles.
  const reviewOf = (id: string): ReviewState => prList.get(id)?.review ?? { state: 'none' };

  const app = express();
  app.use(guardRequest);
  app.use(express.json({ limit: MAX_BODY_SIZE }));
  app.use(express.text({ limit: MAX_BODY_SIZE })); // sendBeacon posts comments as text/plain

  app.get('/api/server-info', (_req, res) => {
    res.json({
      app: 'difit',
      mode: 'multi',
      version: pkg.version,
      pid: process.pid,
      startedAt,
      // A background server's stderr goes nowhere, so a list it cannot save says so here.
      prList: { path: prList.path, warning: prList.warning() },
    });
  });

  app.get('/api/sessions', (_req, res) => {
    res.json({ sessions: prList.list().map(describeSaved) });
  });

  app.post('/api/sessions', requireJsonContentType, async (req, res) => {
    const parsed = parseCreateSessionRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const { entry, created } = await openSession(parsed.value);
      res.status(created ? 201 : 200).json(toSessionInfo(entry, reviewOf(entry.id)));
    } catch (error) {
      const label = labelOf(parsed.value.pr);
      if (error instanceof PullRequestFetchError) {
        console.error(`Failed to fetch ${label} with gh: ${error.message}`);
        res.status(502).json({ error: GH_FAILURE_ERROR });
        return;
      }
      console.error(`Failed to open a session for ${label}: ${describeErrorWithStack(error)}`);
      res.status(500).json({ error: OPEN_FAILURE_ERROR });
    }
  });

  // Closes an open PR, or drops a saved one still waiting for its restore or failed. The
  // list is saved before the answer.
  app.delete('/api/sessions/:id', requireJsonContentType, async (req, res) => {
    const { id } = req.params;
    if (creating.has(id)) {
      res.status(409).json({ error: 'Session is still being created; retry once it is open' });
      return;
    }
    const entry = sessions.get(id);
    if (!entry && !queued.has(id) && !failed.has(id)) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    sessions.delete(id);
    queued.delete(id);
    failed.delete(id);
    await prList.remove(id);
    await entry?.session.dispose();
    res.json({ success: true, id });
  });

  // Marks a saved PR as reviewed, or clears the mark. The list is saved before the answer.
  app.put('/api/sessions/:id/review', requireJsonContentType, async (req, res) => {
    const { id } = req.params;
    if (!prList.has(id)) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    const state = parseReviewRequest(req.body);
    if (!state) {
      res.status(400).json({ error: 'state must be "done" or "none"' });
      return;
    }
    const saving = state === 'done' ? prList.markDone(id) : prList.unmark(id);
    const review = reviewOf(id);
    await saving;
    res.json({ success: true, id, review });
  });

  // A bot takes the mark: a done review becomes acknowledged, once.
  app.post('/api/sessions/:id/review/ack', requireJsonContentType, async (req, res) => {
    const { id } = req.params;
    if (!prList.has(id)) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    if (reviewOf(id).state !== 'done') {
      res.status(409).json({
        error: 'The review is not done (it is not marked, or it was acknowledged already)',
      });
      return;
    }
    const saving = prList.acknowledge(id);
    const review = reviewOf(id);
    await saving;
    res.json({ success: true, id, review });
  });

  app.get('/', (_req, res) => {
    sendClientPage(clientDir, res);
  });

  app.use('/s/:id', (req, res, next) => {
    const entry = sessions.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    // Express matches routes ignoring case and one trailing slash; compare the same way.
    const routePath = req.path.toLowerCase().replace(/\/$/, '');
    if (routePath === '' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendClientPage(clientDir, res);
      return;
    }
    if (entry.pendingClean && req.method === 'GET' && routePath === '/api/diff') {
      announceCleanOnce(entry, res);
    }
    entry.session.router(req, res, next);
  });

  app.use(express.static(clientDir, { index: false }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(handleError);

  return { app, restoreSessions };
}

export async function startMultiServer(options: {
  github: PullRequestSource;
  prList: PrList;
  preferredPort?: number;
  host?: string;
}): Promise<{ port: number; url: string; server: Server; restoreSessions: () => Promise<void> }> {
  const host = options.host ?? 'localhost';
  // POST /api/sessions runs gh with the user's GitHub token; never listen beyond loopback.
  if (!LISTEN_HOSTS.has(host)) {
    throw new Error(
      `The multi-session server only listens on loopback (localhost or 127.0.0.1), not ${host}`,
    );
  }
  const { app, restoreSessions } = createMultiSessionApp(options);
  const { server } = await startServerWithFallback(app, options.preferredPort ?? 4966, host);
  // startServerWithFallback reports the port it asked for; with 0 the OS picks another.
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('The multi-session server is not listening on a TCP port');
  }
  return { port: address.port, url: `http://${host}:${address.port}`, server, restoreSessions };
}
