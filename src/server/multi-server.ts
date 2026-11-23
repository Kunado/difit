// The multi-session server: one process, one port, one review session per GitHub PR,
// each mounted under /s/<id>/. Kept out of server.ts so the VS Code extension, which
// bundles server.ts, does not ship it.
import { createHash } from 'crypto';
import { type Server } from 'http';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import pkg from '../../package.json' with { type: 'json' };
import { type CommentImport } from '../types/diff.js';
import { normalizeCommentImports } from '../utils/commentImports.js';

import { createReviewSession, type ReviewSession, startServerWithFallback } from './server.js';

/** Reads a pull request from GitHub. The CLI passes its gh-backed functions. */
export interface PullRequestSource {
  getPrPatch(prUrl: string): Promise<string>;
  getPrCommentImports(prUrl: string): Promise<CommentImport[]>;
  getPrTitle(prUrl: string): Promise<string | undefined>;
}

/** A pull request URL that passed parsePullRequestUrl. */
interface PullRequestRef {
  url: string;
  owner: string;
  repo: string;
  number: number;
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
  /** Open watch and heartbeat responses, ended when the session is deleted. */
  readonly streams: Set<Response>;
  /** Set by `clean`; consumed by the first /api/diff response. */
  pendingClean: boolean;
}

// Owner: GitHub login characters, no leading hyphen. Repo: letters, digits, `.`, `_`,
// `-`, no leading hyphen. Number: no leading zero. Nothing may follow the number.
const PR_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._][A-Za-z0-9._-]{0,99})\/pull\/([1-9][0-9]{0,9})$/;
// gh api graphql sends the number as a GraphQL Int.
const MAX_PR_NUMBER = 2_147_483_647;
const PR_URL_ERROR =
  'prUrl must be a URL of the form https://github.com/<owner>/<repo>/pull/<number>';
const GH_FAILURE_ERROR =
  'Could not fetch the pull request with gh. Check that it exists and that gh is installed and logged in (gh auth status). The server log has the details.';

const SESSION_ID_LENGTH = 16;
const MAX_BODY_SIZE = '1mb';
const SSE_PATHS = new Set(['/api/watch', '/api/heartbeat']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_HOST_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const LISTEN_HOSTS = new Set(['localhost', '127.0.0.1']);
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g;

/** gh could not read the PR. The message is safe to log, not to return. */
class PullRequestFetchError extends Error {}

function parsePullRequestUrl(value: unknown): PullRequestRef | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = PR_URL_PATTERN.exec(value);
  const [, owner, repo, digits] = match ?? [];
  if (!owner || !repo || !digits || repo === '.' || repo.includes('..')) {
    return null;
  }
  const number = Number(digits);
  return number <= MAX_PR_NUMBER ? { url: value, owner, repo, number } : null;
}

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

// The same PR always maps to the same ids, so reopening it finds the browser's saved
// comments and viewed marks, which the client keys by repositoryId.
function identifySession(pr: PullRequestRef): { id: string; repositoryId: string } {
  // GitHub owner and repository names are case-insensitive.
  const key = `github.com/${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}/pull/${pr.number}`;
  const digest = createHash('sha256').update(key).digest('hex');
  return { id: digest.slice(0, SESSION_ID_LENGTH), repositoryId: digest };
}

const labelOf = (pr: PullRequestRef) => `${pr.owner}/${pr.repo}#${pr.number}`;

// gh's messages help in the server log but could echo a token, so mask token shapes.
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(GITHUB_TOKEN_PATTERN, '[redacted]');
}

const toSessionInfo = (entry: SessionEntry) => ({
  id: entry.id,
  url: `/s/${entry.id}/`,
  prUrl: entry.prUrl,
  label: entry.label,
  title: entry.title,
  createdAt: entry.createdAt,
});

// Blocks DNS rebinding (a foreign Host) and cross-site writes (a foreign Origin). The
// session routes are guarded too: they expose PR contents and accept comment writes.
function guardRequest(req: Request, res: Response, next: NextFunction): void {
  const { host, origin } = req.headers;
  const port = req.socket.localPort;
  if (!LOOPBACK_HOST_NAMES.some((name) => host === `${name}:${port}`)) {
    res.status(403).json({ error: 'Host not allowed' });
    return;
  }
  if (!SAFE_METHODS.has(req.method) && origin !== undefined && origin !== `http://${host}`) {
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
  console.error('Unexpected error in the multi-session server:', error);
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

export function createMultiSessionApp({ github }: { github: PullRequestSource }): Express {
  const startedAt = new Date().toISOString();
  // Insertion order is creation order, which GET /api/sessions reports.
  const sessions = new Map<string, SessionEntry>();
  // Creations still waiting on gh, so concurrent requests for one PR share them.
  const creating = new Map<string, Promise<SessionEntry>>();

  async function createEntry(
    id: string,
    repositoryId: string,
    { pr, commentImports, clean }: CreateSessionRequest,
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
      github.getPrTitle(pr.url).catch(() => undefined),
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
      streams: new Set(),
      pendingClean: clean,
    };
  }

  async function openSession(
    request: CreateSessionRequest,
  ): Promise<{ entry: SessionEntry; created: boolean }> {
    const { id, repositoryId } = identifySession(request.pr);
    const existing = sessions.get(id);
    if (existing) {
      return { entry: existing, created: false };
    }
    const pending = creating.get(id);
    if (pending) {
      return { entry: await pending, created: false };
    }

    const creation = createEntry(id, repositoryId, request)
      .then((entry) => {
        sessions.set(id, entry);
        return entry;
      })
      .finally(() => creating.delete(id));
    creating.set(id, creation);
    return { entry: await creation, created: true };
  }

  const app = express();
  app.use(guardRequest);
  app.use(express.json({ limit: MAX_BODY_SIZE }));
  app.use(express.text({ limit: MAX_BODY_SIZE })); // sendBeacon posts comments as text/plain

  app.get('/api/server-info', (_req, res) => {
    res.json({ app: 'difit', mode: 'multi', version: pkg.version, pid: process.pid, startedAt });
  });

  app.get('/api/sessions', (_req, res) => {
    res.json({ sessions: Array.from(sessions.values(), toSessionInfo) });
  });

  app.post('/api/sessions', requireJsonContentType, async (req, res) => {
    const parsed = parseCreateSessionRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const { entry, created } = await openSession(parsed.value);
      res.status(created ? 201 : 200).json(toSessionInfo(entry));
    } catch (error) {
      const label = labelOf(parsed.value.pr);
      if (error instanceof PullRequestFetchError) {
        console.error(`Failed to fetch ${label} with gh: ${error.message}`);
        res.status(502).json({ error: GH_FAILURE_ERROR });
        return;
      }
      console.error(`Failed to open a session for ${label}:`, error);
      res.status(500).json({ error: 'Failed to open the session' });
    }
  });

  app.delete('/api/sessions/:id', requireJsonContentType, async (req, res) => {
    const entry = sessions.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    sessions.delete(entry.id);
    await entry.session.dispose();
    for (const stream of entry.streams) {
      // The heartbeat timer stops on the request's close event, which follows end().
      // A tick in between writes after end; that error is expected and harmless.
      stream.on('error', () => {});
      stream.end();
    }
    res.json({ success: true, id: entry.id });
  });

  app.use('/s/:id', (req, res, next) => {
    const entry = sessions.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'Unknown session' });
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && SSE_PATHS.has(req.path)) {
      entry.streams.add(res);
      res.on('close', () => entry.streams.delete(res));
    }
    if (entry.pendingClean && req.method === 'GET' && req.path === '/api/diff') {
      announceCleanOnce(entry, res);
    }
    entry.session.router(req, res, next);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(handleError);

  return app;
}

export async function startMultiServer(options: {
  github: PullRequestSource;
  preferredPort?: number;
  host?: string;
}): Promise<{ port: number; url: string; server: Server }> {
  const host = options.host ?? 'localhost';
  // POST /api/sessions runs gh with the user's GitHub token; never listen beyond loopback.
  if (!LISTEN_HOSTS.has(host)) {
    throw new Error(
      `The multi-session server only listens on loopback (localhost or 127.0.0.1), not ${host}`,
    );
  }
  return await startServerWithFallback(
    createMultiSessionApp(options),
    options.preferredPort ?? 4966,
    host,
  );
}
