// The github.com pull request URLs the multi-session server accepts, and the session ids
// it derives from them. Shared by the server and the PR list it saves.
import { createHash } from 'crypto';

import { SESSION_ID_LENGTH } from '../utils/sessionPath.js';

/** A pull request URL that passed parsePullRequestUrl. */
export interface PullRequestRef {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

// Owner: GitHub login characters, no leading hyphen. Repo: letters, digits, `.`, `_`,
// `-`, no leading hyphen. Number: no leading zero. Nothing may follow the number.
const PR_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._][A-Za-z0-9._-]{0,99})\/pull\/([1-9][0-9]{0,9})$/;
// gh api graphql sends the number as a GraphQL Int.
const MAX_PR_NUMBER = 2_147_483_647;

export function parsePullRequestUrl(value: unknown): PullRequestRef | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = PR_URL_PATTERN.exec(value);
  const [, owner, repo, digits] = match ?? [];
  // A `.git` suffix names the same repository, so it would open a duplicate session.
  if (
    !owner ||
    !repo ||
    !digits ||
    repo === '.' ||
    repo.includes('..') ||
    repo.toLowerCase().endsWith('.git')
  ) {
    return null;
  }
  const number = Number(digits);
  return number <= MAX_PR_NUMBER ? { url: value, owner, repo, number } : null;
}

// The same PR always maps to the same ids, so reopening it finds the browser's saved
// comments and viewed marks, which the client keys by repositoryId.
export function identifySession(pr: PullRequestRef): { id: string; repositoryId: string } {
  // GitHub owner and repository names are case-insensitive.
  const key = `github.com/${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}/pull/${pr.number}`;
  const digest = createHash('sha256').update(key).digest('hex');
  return { id: digest.slice(0, SESSION_ID_LENGTH), repositoryId: digest };
}

/** The /s/<id>/ id the server gives a PR, or null when prUrl is not a PR URL it accepts. */
export function sessionIdForPullRequest(prUrl: string): string | null {
  const pr = parsePullRequestUrl(prUrl);
  return pr ? identifySession(pr).id : null;
}

export const labelOf = (pr: PullRequestRef) => `${pr.owner}/${pr.repo}#${pr.number}`;
