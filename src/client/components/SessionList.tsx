import { useCallback, useEffect, useState } from 'react';

import { Logo } from './Logo';

/** One open PR, as GET /api/sessions reports it. */
interface SessionSummary {
  id: string;
  url: string;
  label: string;
  title: string | undefined;
  createdAt: string;
}

const POLL_INTERVAL_MS = 3000;

const stringField = (item: object, key: string): string | undefined => {
  const value: unknown = Reflect.get(item, key);
  return typeof value === 'string' ? value : undefined;
};

function parseSession(item: unknown): SessionSummary | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const id = stringField(item, 'id');
  const url = stringField(item, 'url');
  const label = stringField(item, 'label');
  const createdAt = stringField(item, 'createdAt');
  return id && url && label && createdAt
    ? { id, url, label, title: stringField(item, 'title'), createdAt }
    : null;
}

function parseSessions(body: unknown): SessionSummary[] | null {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('sessions' in body) ||
    !Array.isArray(body.sessions)
  ) {
    return null;
  }
  const items: unknown[] = body.sessions;
  const sessions = items.map(parseSession);
  return sessions.every((session): session is SessionSummary => session !== null) ? sessions : null;
}

export function SessionList() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/sessions');
      const list = response.ok ? parseSessions(await response.json()) : null;
      if (!list) {
        throw new Error(`GET /api/sessions answered ${response.status}`);
      }
      setSessions(list);
      setListError(null);
    } catch {
      setListError('Could not load the open pull requests. Retrying…');
    }
  }, []);

  // Polling is enough for a list that changes only when someone adds or closes a PR.
  // A hidden tab stops polling and catches up when shown again.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      void refresh();
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else if (timer === undefined) {
        start();
      }
    };

    if (document.visibilityState !== 'hidden') {
      start();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh]);

  const close = async (session: SessionSummary) => {
    setCloseError(null);
    try {
      // The server takes session writes only as JSON, which a cross-site form cannot send.
      const response = await fetch(`/api/sessions/${session.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      // 404: it was closed elsewhere, which is what we wanted.
      if (!response.ok && response.status !== 404) {
        throw new Error(`DELETE answered ${response.status}`);
      }
      setSessions((current) => current?.filter(({ id }) => id !== session.id) ?? current);
    } catch {
      setCloseError(`Could not close ${session.label}.`);
    }
  };

  return (
    <div className="min-h-screen bg-github-bg-primary text-github-text-primary">
      <main className="mx-auto max-w-4xl px-6 py-10">
        <header className="mb-6 flex items-center gap-4">
          <Logo style={{ height: '28px', width: 'auto' }} />
          <h1 className="text-xl font-semibold">Open pull requests</h1>
        </header>

        {[listError, closeError].map(
          (message) =>
            message && (
              <p
                key={message}
                role="alert"
                className="mb-4 rounded border border-github-danger px-4 py-2 text-sm text-github-danger"
              >
                {message}
              </p>
            ),
        )}

        {sessions === null ? (
          !listError && <p className="text-github-text-secondary">Loading…</p>
        ) : sessions.length === 0 ? (
          <div className="rounded-lg border border-github-border px-6 py-10 text-center">
            <p className="font-medium">No open pull requests.</p>
            <p className="mt-2 text-sm text-github-text-secondary">
              Add one with <code className="font-mono">POST /api/sessions</code> and a JSON body
              like <code className="font-mono">{'{"prUrl": "https://github.com/o/r/pull/1"}'}</code>
              .
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-github-border rounded-lg border border-github-border">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center gap-4 px-4 py-3">
                <a href={session.url} className="min-w-0 flex-1 hover:underline">
                  <span className="block font-mono text-sm text-github-text-secondary">
                    {session.label}
                  </span>
                  {session.title && (
                    <span className="block truncate font-medium">{session.title}</span>
                  )}
                </a>
                <time
                  dateTime={session.createdAt}
                  className="shrink-0 text-xs text-github-text-secondary"
                >
                  {new Date(session.createdAt).toLocaleString()}
                </time>
                <button
                  type="button"
                  onClick={() => void close(session)}
                  aria-label={`Close ${session.label}`}
                  className="shrink-0 rounded border border-github-border px-3 py-1 text-sm text-github-text-secondary transition-colors hover:border-github-danger hover:text-github-danger"
                >
                  Close
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
