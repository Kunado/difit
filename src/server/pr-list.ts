// The list of PRs the multi-session server has open, kept in a JSON file so that a
// restarted server reopens them:
//   { "version": 1, "pullRequests": [{ "url": "https://github.com/...", "addedAt": "<ISO>" }] }
// A row may also carry a review mark: "review": { "state": "done", "doneAt": "<ISO>" }, or
// "state": "acknowledged" with "acknowledgedAt" too. A row without one is not marked.
// Rows come oldest first. A file it cannot read as that shape is never overwritten.
import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';

import { identifySession, parsePullRequestUrl, type PullRequestRef } from './pull-request-url.js';
import { getUserConfigPath } from './user-config.js';

/**
 * Whether the user has finished reviewing the PR: none until marked done; acknowledged once
 * a bot has taken the mark. Setting a PR back to none forgets both times.
 */
export type ReviewState =
  | { readonly state: 'none' }
  | { readonly state: 'done'; readonly doneAt: string }
  | { readonly state: 'acknowledged'; readonly doneAt: string; readonly acknowledgedAt: string };

export interface SavedPullRequest {
  readonly id: string;
  readonly pr: PullRequestRef;
  readonly addedAt: string;
  readonly review: ReviewState;
}

export interface PrList {
  readonly path: string;
  /** Why the list is not being saved, or why the last save failed. */
  warning(): string | undefined;
  /** The saved PRs, oldest first. */
  list(): SavedPullRequest[];
  get(id: string): SavedPullRequest | undefined;
  has(id: string): boolean;
  /** Saves the PR unless it is saved already. Resolves once the file is written. */
  add(pr: PullRequestRef): Promise<void>;
  /** Drops the PR. Resolves once the file is written. */
  remove(id: string): Promise<void>;
  /**
   * Marks a PR that is not marked yet as done now. A done or acknowledged PR keeps its mark,
   * so doneAt stays the same. Resolves once the file is written.
   */
  markDone(id: string): Promise<void>;
  /** Turns a done PR into an acknowledged one. Any other PR is left as it is. */
  acknowledge(id: string): Promise<void>;
  /** Sets a done or acknowledged PR back to none, forgetting its times. */
  unmark(id: string): Promise<void>;
  /**
   * Waits for in-flight and queued saves to complete, up to the timeout. Returns true if all
   * saves finished, false if the timeout elapsed.
   */
  flush(timeoutMs: number): Promise<boolean>;
  /**
   * Removes the temporary file for this process, if it exists. Called when flush times out
   * and the process is about to exit.
   */
  discardTempFile(): Promise<void>;
}

type Access = { kind: 'writable' } | { kind: 'read-only'; warning: string };

interface Contents {
  access: Access;
  saved: SavedPullRequest[];
  // Rows that name no PR the server accepts. They are not opened and stay in the file.
  unreadable: unknown[];
}

const FILE_VERSION = 1;

// Next to config.json, so DIFIT_CONFIG_DIR moves both.
export const defaultPrListPath = () => join(dirname(getUserConfigPath()), 'prs.json');

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isErrorCode = (error: unknown, code: string) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: process does not exist
    // EPERM: process exists but we don't have permission - treat as alive
    if (isErrorCode(error, 'ESRCH')) {
      return false;
    }
    return true;
  }
};

const readOnly = (problem: string): Contents => ({
  access: {
    kind: 'read-only',
    warning: `${problem}. The PR list is not saved until the file is fixed or removed and difit restarts.`,
  },
  saved: [],
  unreadable: [],
});

const isDateString = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

// A mark it cannot read is no mark: the PR still opens, and the next save drops the mark.
function parseReview(value: unknown): ReviewState {
  if (isPlainObject(value) && isDateString(value.doneAt)) {
    if (value.state === 'done') {
      return { state: 'done', doneAt: value.doneAt };
    }
    if (value.state === 'acknowledged' && isDateString(value.acknowledgedAt)) {
      return { state: 'acknowledged', doneAt: value.doneAt, acknowledgedAt: value.acknowledgedAt };
    }
  }
  return { state: 'none' };
}

function parseRow(row: unknown): SavedPullRequest | null {
  if (
    !isPlainObject(row) ||
    typeof row.addedAt !== 'string' ||
    Number.isNaN(Date.parse(row.addedAt))
  ) {
    return null;
  }
  const pr = parsePullRequestUrl(row.url);
  return pr
    ? { id: identifySession(pr).id, pr, addedAt: row.addedAt, review: parseReview(row.review) }
    : null;
}

async function readContents(path: string): Promise<Contents> {
  // Clean up stale temporary files from previous servers that didn't shut down cleanly.
  // Pattern: <basename>.<pid>.tmp where pid is numeric
  const dir = dirname(path);
  const filename = basename(path);
  const tmpPattern = new RegExp(
    `^${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.tmp$`,
  );
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      const match = tmpPattern.exec(file);
      if (match && match[1]) {
        const pid = parseInt(match[1], 10);
        // Skip our own pid's temp file (we might be saving right now)
        if (pid !== process.pid && !isProcessAlive(pid)) {
          await fs.rm(join(dir, file), { force: true }).catch(() => {
            // Cleanup failure does not prevent startup
          });
        }
      }
    }
  } catch {
    // If we can't read the directory or clean up, continue with startup anyway
  }

  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (error) {
    return isErrorCode(error, 'ENOENT')
      ? { access: { kind: 'writable' }, saved: [], unreadable: [] }
      : readOnly(`Could not read ${path}: ${describeError(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return readOnly(`${path} is not valid JSON`);
  }
  if (
    !isPlainObject(value) ||
    value.version !== FILE_VERSION ||
    !Array.isArray(value.pullRequests)
  ) {
    return readOnly(`${path} is not a version ${FILE_VERSION} difit PR list`);
  }
  const rows: unknown[] = value.pullRequests;
  const saved = new Map<string, SavedPullRequest>();
  const unreadable: unknown[] = [];
  for (const row of rows) {
    const parsed = parseRow(row);
    if (!parsed) {
      unreadable.push(row);
    } else if (!saved.has(parsed.id)) {
      // A later row for the same PR goes with the next save.
      saved.set(parsed.id, parsed);
    }
  }
  return {
    access: { kind: 'writable' },
    saved: [...saved.values()].sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt)),
    unreadable,
  };
}

/** Reads the list at path. A missing file is an empty list, created on the first save. */
export async function openPrList(path: string): Promise<PrList> {
  const { access, saved: initial, unreadable } = await readContents(path);
  // Insertion order is addedAt order: rows load sorted, and each new PR is the newest.
  const saved = new Map(initial.map((pr) => [pr.id, pr]));
  let saveError: string | undefined;
  let lastSave = Promise.resolve();

  async function write(): Promise<void> {
    const contents = {
      version: FILE_VERSION,
      pullRequests: [
        ...Array.from(saved.values(), ({ pr, addedAt, review }) => ({
          url: pr.url,
          addedAt,
          ...(review.state === 'none' ? {} : { review }),
        })),
        ...unreadable,
      ],
    };
    // The temporary name holds only the pid; saves run one at a time, so it is never shared.
    const tmpPath = `${path}.${process.pid}.tmp`;
    try {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(tmpPath, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
      await fs.rename(tmpPath, path);
      saveError = undefined;
    } catch (error) {
      saveError = `Could not save the PR list to ${path}: ${describeError(error)}`;
      console.error(saveError);
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  // Each save writes the list as it is when its turn comes, after the saves before it.
  function save(): Promise<void> {
    if (access.kind === 'read-only') {
      return Promise.resolve();
    }
    lastSave = lastSave.then(write);
    return lastSave;
  }

  // Replaces the review mark of a saved PR, if it is saved and `change` gives a new one.
  function review(id: string, change: (current: ReviewState) => ReviewState | undefined) {
    const current = saved.get(id);
    const next = current && change(current.review);
    if (!current || !next) {
      return Promise.resolve();
    }
    saved.set(id, { ...current, review: next });
    return save();
  }

  return {
    path,
    warning: () => (access.kind === 'read-only' ? access.warning : saveError),
    list: () => [...saved.values()],
    get: (id) => saved.get(id),
    has: (id) => saved.has(id),
    add(pr) {
      const { id } = identifySession(pr);
      if (saved.has(id)) {
        return Promise.resolve();
      }
      saved.set(id, { id, pr, addedAt: new Date().toISOString(), review: { state: 'none' } });
      return save();
    },
    remove(id) {
      return saved.delete(id) ? save() : Promise.resolve();
    },
    markDone: (id) =>
      review(id, (current) =>
        current.state === 'none' ? { state: 'done', doneAt: new Date().toISOString() } : undefined,
      ),
    acknowledge: (id) =>
      review(id, (current) =>
        current.state === 'done'
          ? { ...current, state: 'acknowledged', acknowledgedAt: new Date().toISOString() }
          : undefined,
      ),
    unmark: (id) =>
      review(id, (current) => (current.state === 'none' ? undefined : { state: 'none' })),
    async flush(timeoutMs) {
      if (access.kind === 'read-only') {
        return true;
      }
      const deadline = Date.now() + timeoutMs;
      let timerId: NodeJS.Timeout | undefined;

      try {
        // 保存が動かなくなるまで（lastSave が変わらなくなるまで）繰り返し待つ
        while (true) {
          const current = lastSave;
          const remaining = deadline - Date.now();

          if (remaining <= 0) {
            return false;
          }

          const completed = await Promise.race([
            current.then(() => true),
            new Promise<boolean>((resolve) => {
              timerId = setTimeout(() => resolve(false), remaining);
            }),
          ]);

          if (timerId !== undefined) {
            clearTimeout(timerId);
            timerId = undefined;
          }

          if (!completed) {
            return false; // タイムアウト
          }

          // 保存が動かなくなった（新しい保存が積まれていない）
          if (lastSave === current) {
            return true;
          }
          // まだ新しい保存がある、ループ継続
        }
      } finally {
        if (timerId !== undefined) {
          clearTimeout(timerId);
        }
      }
    },
    async discardTempFile() {
      const tmpPath = `${path}.${process.pid}.tmp`;
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    },
  };
}
