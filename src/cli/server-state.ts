// The state file through which `difit serve` tells other difit commands where it runs.
// A file is trusted only while its process lives and its port answers /api/server-info
// as the multi-session server of that same pid; anything else is stale.
import { promises as fs, readFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';

import { getUserConfigPath } from '../server/user-config.js';

export interface ServerState {
  host: string;
  port: number;
  pid: number;
  version: string;
  startedAt: string;
}

type ServerLookup =
  | { kind: 'none' }
  | { kind: 'running'; state: ServerState }
  // The process lives but its port gave no answer in time: maybe a busy difit server.
  | { kind: 'unresponsive'; state: ServerState }
  | { kind: 'stale'; raw: string; reason: string };

/** What a state's port says to /api/server-info. */
type ProbeResult = 'this-server' | 'other' | 'refused' | 'no-answer';

const PROBE_TIMEOUT_MS = 2_000;

// Next to config.json, so DIFIT_CONFIG_DIR moves both.
const getServerStatePath = () => join(dirname(getUserConfigPath()), 'server.json');

export const serverBaseUrl = (state: ServerState) => `http://${state.host}:${state.port}`;

const isErrorCode = (error: unknown, code: string) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

function parseServerState(raw: string): ServerState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { host, port, pid, version, startedAt } = value as Record<string, unknown>;
  return typeof host === 'string' &&
    Number.isInteger(port) &&
    Number.isInteger(pid) &&
    typeof version === 'string' &&
    typeof startedAt === 'string'
    ? { host, port: Number(port), pid: Number(pid), version, startedAt }
    : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return isErrorCode(error, 'EPERM');
  }
}

// fetch reports a refused connection as a TypeError whose cause has the code; with
// several addresses for the host (localhost), the cause is an AggregateError of them.
function isConnectionRefused(error: unknown): boolean {
  const cause = typeof error === 'object' && error !== null && 'cause' in error && error.cause;
  if (isErrorCode(cause, 'ECONNREFUSED')) {
    return true;
  }
  return (
    cause instanceof AggregateError &&
    cause.errors.length > 0 &&
    cause.errors.every((attempt) => isErrorCode(attempt, 'ECONNREFUSED'))
  );
}

/** Asks the state's port whether it is the multi-session server of the state's pid. */
export async function probeServer(state: ServerState): Promise<ProbeResult> {
  let info: unknown;
  try {
    const response = await fetch(`${serverBaseUrl(state)}/api/server-info`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return 'other';
    }
    info = await response.json().catch(() => undefined);
  } catch (error) {
    return isConnectionRefused(error) ? 'refused' : 'no-answer';
  }
  return typeof info === 'object' &&
    info !== null &&
    'app' in info &&
    info.app === 'difit' &&
    'mode' in info &&
    info.mode === 'multi' &&
    'pid' in info &&
    info.pid === state.pid
    ? 'this-server'
    : 'other';
}

export async function findServer(): Promise<ServerLookup> {
  let raw: string;
  try {
    raw = await fs.readFile(getServerStatePath(), 'utf8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return { kind: 'none' };
    }
    throw error;
  }
  const state = parseServerState(raw);
  if (!state) {
    return { kind: 'stale', raw, reason: 'the state file is not valid' };
  }
  if (!isProcessAlive(state.pid)) {
    return { kind: 'stale', raw, reason: `process ${state.pid} is not running` };
  }
  const probe = await probeServer(state);
  switch (probe) {
    case 'this-server':
      return { kind: 'running', state };
    case 'no-answer':
      return { kind: 'unresponsive', state };
    case 'other':
    case 'refused':
      return {
        kind: 'stale',
        raw,
        reason: `${serverBaseUrl(state)} is not the difit server of process ${state.pid}`,
      };
    default: {
      const _exhaustive: never = probe;
      return _exhaustive;
    }
  }
}

export const notAnswering = (state: ServerState) =>
  new Error(
    `The difit server in ${getServerStatePath()} (pid ${state.pid}, ${serverBaseUrl(state)}) is running but not answering. Try again in a moment.`,
  );

// Removes the file only if it still holds what was judged, so a server that claimed it
// in the meantime keeps its file.
function removeStateFileIf(matches: (raw: string) => boolean): void {
  const path = getServerStatePath();
  try {
    if (matches(readFileSync(path, 'utf8'))) {
      unlinkSync(path);
    }
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

export function removeStaleServerState(raw: string): void {
  removeStateFileIf((current) => current === raw);
}

/** Removes the state file if it is this server's. Synchronous, for signal handlers. */
export function releaseServerState(state: ServerState): void {
  removeStateFileIf((current) => {
    const recorded = parseServerState(current);
    return recorded?.pid === state.pid && recorded.startedAt === state.startedAt;
  });
}

/**
 * Writes the state file unless one exists. The content goes to a temporary file first
 * and is hard-linked into place: like an exclusive create it fails when the file exists,
 * and like a rename no reader ever sees it half written.
 */
export async function claimServerState(state: ServerState): Promise<boolean> {
  const path = getServerStatePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await fs.link(tmpPath, path);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  } finally {
    await fs.unlink(tmpPath);
  }
}
