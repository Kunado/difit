import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionList } from './SessionList';

interface FakeSession {
  id: string;
  url: string;
  prUrl: string;
  label: string;
  title?: string;
  createdAt: string;
}

const ALPHA: FakeSession = {
  id: 'aaaaaaaaaaaaaaaa',
  url: '/s/aaaaaaaaaaaaaaaa/',
  prUrl: 'https://github.com/octo/alpha/pull/1',
  label: 'octo/alpha#1',
  title: 'Add the alpha feature',
  createdAt: '2026-11-24T01:02:03.000Z',
};

const BETA: FakeSession = {
  id: 'bbbbbbbbbbbbbbbb',
  url: '/s/bbbbbbbbbbbbbbbb/',
  prUrl: 'https://github.com/octo/beta/pull/2',
  label: 'octo/beta#2',
  title: 'Fix the beta bug',
  createdAt: '2026-11-24T04:05:06.000Z',
};

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// Answers like the multi-session server: GET /api/sessions lists `open`, and
// DELETE /api/sessions/:id removes the session from it.
function fakeServer(initial: FakeSession[]) {
  const open = [...initial];
  const requests: RecordedRequest[] = [];
  const state = { failDeletes: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method, headers: new Headers(init?.headers), body: init?.body });
      if (method === 'GET' && url === '/api/sessions') {
        return jsonResponse({ sessions: open });
      }
      const id = /^\/api\/sessions\/([^/]+)$/.exec(url)?.[1];
      if (method === 'DELETE' && id !== undefined) {
        if (state.failDeletes) {
          return jsonResponse({ error: 'Internal server error' }, 500);
        }
        const index = open.findIndex((session) => session.id === id);
        if (index === -1) {
          return jsonResponse({ error: 'Unknown session' }, 404);
        }
        open.splice(index, 1);
        return jsonResponse({ success: true, id });
      }
      return jsonResponse({ error: 'Not found' }, 404);
    }),
  );
  const listRequests = () =>
    requests.filter((request) => request.method === 'GET' && request.url === '/api/sessions');
  return { open, requests, listRequests, state };
}

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('SessionList', () => {
  it('lists each open PR with its label, title, and the time it was added', async () => {
    fakeServer([ALPHA, BETA]);

    render(<SessionList />);

    for (const session of [ALPHA, BETA]) {
      expect(await screen.findByText(session.label)).toBeInTheDocument();
      expect(screen.getByText(session.title ?? '')).toBeInTheDocument();
      const time = document.querySelector(`time[datetime="${session.createdAt}"]`);
      expect(time).not.toBeNull();
      expect(time).toHaveTextContent(/\S/);
    }
  });

  it('links each PR to its review page', async () => {
    fakeServer([ALPHA, BETA]);

    render(<SessionList />);

    expect(await screen.findByRole('link', { name: /octo\/alpha#1/ })).toHaveAttribute(
      'href',
      '/s/aaaaaaaaaaaaaaaa/',
    );
    expect(screen.getByRole('link', { name: /octo\/beta#2/ })).toHaveAttribute(
      'href',
      '/s/bbbbbbbbbbbbbbbb/',
    );
  });

  it('closes a PR with a DELETE the server accepts from a browser page, then drops its row', async () => {
    const server = fakeServer([ALPHA, BETA]);
    const user = userEvent.setup();
    render(<SessionList />);

    await user.click(await screen.findByRole('button', { name: 'Close octo/alpha#1' }));

    await waitFor(() => expect(screen.queryByText(ALPHA.label)).not.toBeInTheDocument());
    expect(screen.getByText(BETA.label)).toBeInTheDocument();
    const deletes = server.requests.filter((request) => request.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    // A relative URL keeps the request same-origin, so the browser sends this page's
    // Origin, which guardRequest accepts. The server takes session writes only as JSON.
    expect(deletes[0]?.url).toBe('/api/sessions/aaaaaaaaaaaaaaaa');
    expect(deletes[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(deletes[0]?.body).toBeUndefined();
    expect(server.open).toEqual([BETA]);
  });

  it('keeps the row and says so when the server fails to close the PR', async () => {
    const server = fakeServer([ALPHA]);
    server.state.failDeletes = true;
    const user = userEvent.setup();
    render(<SessionList />);

    await user.click(await screen.findByRole('button', { name: 'Close octo/alpha#1' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/octo\/alpha#1/);
    expect(screen.getByText(ALPHA.label)).toBeInTheDocument();
  });

  it('drops the row when the PR was already closed elsewhere', async () => {
    const server = fakeServer([ALPHA]);
    const user = userEvent.setup();
    render(<SessionList />);
    const close = await screen.findByRole('button', { name: 'Close octo/alpha#1' });
    server.open.splice(0);

    await user.click(close);

    await waitFor(() => expect(screen.queryByText(ALPHA.label)).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says there are no open PRs and how to add one', async () => {
    fakeServer([]);

    render(<SessionList />);

    expect(await screen.findByText(/no open pull requests/i)).toBeInTheDocument();
    expect(screen.getByText(/POST \/api\/sessions/)).toBeInTheDocument();
  });

  it('picks up PRs added and closed elsewhere by polling', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fakeServer([ALPHA]);
    render(<SessionList />);
    expect(await screen.findByText(ALPHA.label)).toBeInTheDocument();

    server.open.splice(0, 1, BETA);
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(await screen.findByText(BETA.label)).toBeInTheDocument();
    expect(screen.queryByText(ALPHA.label)).not.toBeInTheDocument();
  });

  it('stops polling while the tab is hidden and refreshes when it is shown again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fakeServer([ALPHA]);
    render(<SessionList />);
    expect(await screen.findByText(ALPHA.label)).toBeInTheDocument();

    act(() => setVisibility('hidden'));
    const requestsWhenHidden = server.listRequests().length;
    server.open.push(BETA);
    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(server.listRequests()).toHaveLength(requestsWhenHidden);
    expect(screen.queryByText(BETA.label)).not.toBeInTheDocument();

    act(() => setVisibility('visible'));

    expect(await screen.findByText(BETA.label)).toBeInTheDocument();
  });
});
