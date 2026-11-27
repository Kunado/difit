// `difit review`: the CLI a bot polls to find the PRs a user marked as reviewed, and uses
// to take the mark. It only asks the running server; it never starts one and never runs gh.
import { Command } from 'commander';

import { resolvePullRequestUrl } from './serve.js';
import { findServer, notAnswering, serverBaseUrl } from './server-state.js';

interface ReviewEntry {
  url: string;
  id: string;
  label: string;
  doneAt: string | null;
  commentCount: number | null;
  state: string;
}

const NO_SERVER_ERROR = 'No difit server is running. Start one with difit serve';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorOf = (body: unknown) =>
  isRecord(body) && typeof body.error === 'string' ? body.error : undefined;

// A row the server listed. Only an open session has its comments loaded, so only it has a
// commentCount; a PR still restoring or failed has none.
function parseEntry(row: unknown): { entry: ReviewEntry; open: boolean } | null {
  if (!isRecord(row)) {
    return null;
  }
  const { id, prUrl, label, status, review, commentCount } = row;
  if (
    typeof id !== 'string' ||
    typeof prUrl !== 'string' ||
    typeof label !== 'string' ||
    !isRecord(review) ||
    typeof review.state !== 'string'
  ) {
    return null;
  }
  return {
    open: status === 'open',
    entry: {
      url: prUrl,
      id,
      label,
      doneAt: typeof review.doneAt === 'string' ? review.doneAt : null,
      commentCount: typeof commentCount === 'number' ? commentCount : null,
      state: review.state,
    },
  };
}

function handleCommandError(error: unknown): never {
  if (error instanceof TypeError && error.message.includes('fetch failed')) {
    console.error('Error: Cannot connect to the difit server. Is the server running?');
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  process.exit(1);
}

async function listEntries(options: { done: boolean }): Promise<ReviewEntry[]> {
  const found = await findServer();
  if (found.kind === 'unresponsive') {
    throw notAnswering(found.state);
  }
  // No server, or a state file left by one that is gone: nothing is marked.
  if (found.kind !== 'running') {
    return [];
  }
  const response = await fetch(`${serverBaseUrl(found.state)}/api/sessions`);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(body) || !Array.isArray(body.sessions)) {
    throw new Error(errorOf(body) ?? `The difit server answered ${response.status}`);
  }
  const rows = body.sessions.flatMap((row: unknown) => parseEntry(row) ?? []);
  return rows
    .filter(({ entry, open }) => !options.done || (entry.state === 'done' && open))
    .map(({ entry }) => entry);
}

const textLine = ({ url, label, state, doneAt, commentCount }: ReviewEntry) =>
  [url, label, state, doneAt ?? '-', commentCount ?? '-'].join('\t');

export function createReviewCommand(): Command {
  const review = new Command('review').description(
    'List the PRs marked as reviewed on the running difit server, or take a mark',
  );

  review
    .command('list')
    .description('List the PRs on the running difit server (none when no server is running)')
    .option('--done', 'only PRs marked done and not acknowledged yet')
    .option('--json', 'print [{ url, id, label, doneAt, commentCount, state }]')
    .action(async (opts: { done?: boolean; json?: boolean }) => {
      try {
        const entries = await listEntries({ done: opts.done === true });
        if (opts.json) {
          console.log(JSON.stringify(entries));
        } else if (entries.length > 0) {
          console.log(entries.map(textLine).join('\n'));
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  review
    .command('ack')
    .description('Acknowledge the done mark of a PR on the running difit server')
    .option('--pr <url>', 'GitHub PR URL, as for difit comment --pr')
    .action(async (opts: { pr?: string }) => {
      try {
        if (opts.pr === undefined) {
          throw new Error('--pr <url> is required');
        }
        const { url, sessionId } = resolvePullRequestUrl(opts.pr);
        const found = await findServer();
        if (found.kind === 'unresponsive') {
          throw notAnswering(found.state);
        }
        if (found.kind !== 'running') {
          throw new Error(NO_SERVER_ERROR);
        }
        const response = await fetch(
          `${serverBaseUrl(found.state)}/api/sessions/${sessionId}/review/ack`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        );
        const body: unknown = await response.json().catch(() => undefined);
        if (response.status === 404) {
          throw new Error(`${url} is not in the difit server's list`);
        }
        if (!response.ok) {
          throw new Error(errorOf(body) ?? `The difit server answered ${response.status}`);
        }
        const acknowledged = isRecord(body) && isRecord(body.review) ? body.review : {};
        console.log(JSON.stringify({ id: sessionId, url, ...acknowledged }));
      } catch (error) {
        handleCommandError(error);
      }
    });

  return review;
}
