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

// A saved PR the server is still reopening or could not reopen: it has no page yet.
interface PendingSession {
  id: string;
  status: 'restoring' | 'failed';
  prUrl: string;
  label: string;
  error?: string;
}

const RESTORING: PendingSession = {
  id: 'cccccccccccccccc',
  status: 'restoring',
  prUrl: 'https://github.com/octo/gamma/pull/3',
  label: 'octo/gamma#3',
};

const FAILED: PendingSession = {
  id: 'dddddddddddddddd',
  status: 'failed',
  prUrl: 'https://github.com/octo/delta/pull/4',
  label: 'octo/delta#4',
  error: 'Could not fetch the pull request with gh.',
};

// Answers like the multi-session server: GET /api/sessions lists `open`,
// GET /api/server-info reports `prList.warning`, and DELETE /api/sessions/:id removes the
// session from the list.
function fakeServer(initial: Array<FakeSession | PendingSession>) {
  const open = [...initial];
  const requests: RecordedRequest[] = [];
  const state: { failDeletes: boolean; warning: string | undefined; serverInfoStatus: number } = {
    failDeletes: false,
    warning: undefined,
    serverInfoStatus: 200,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method, headers: new Headers(init?.headers), body: init?.body });
      if (method === 'GET' && url === '/api/sessions') {
        return jsonResponse({ sessions: open });
      }
      if (method === 'GET' && url === '/api/server-info') {
        return jsonResponse(
          {
            app: 'difit',
            mode: 'multi',
            prList: { path: '/home/me/.difit/prs.json', warning: state.warning },
          },
          state.serverInfoStatus,
        );
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

  it('keeps listing the open PRs while saved ones are being restored or failed', async () => {
    fakeServer([ALPHA, RESTORING, FAILED]);

    render(<SessionList />);

    expect(await screen.findByRole('link', { name: /octo\/alpha#1/ })).toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });

  it('shows a PR being restored as restoring, without a link or a Close button', async () => {
    fakeServer([ALPHA, RESTORING]);

    render(<SessionList />);

    expect(await screen.findByText(RESTORING.label)).toBeInTheDocument();
    expect(screen.getByText(/Restoring/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /octo\/gamma#3/ })).not.toBeInTheDocument();
    // The server answers 409 to a DELETE while the PR is being created, and the list
    // cannot tell a PR waiting to be restored from one being restored.
    expect(screen.queryByRole('button', { name: 'Close octo/gamma#3' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close octo/alpha#1' })).toBeInTheDocument();
  });

  it('shows a PR that failed to restore as failed with the server error, without a link', async () => {
    fakeServer([FAILED]);

    render(<SessionList />);

    expect(await screen.findByText(FAILED.label)).toBeInTheDocument();
    expect(screen.getByText(/Failed/)).toBeInTheDocument();
    expect(screen.getByText(FAILED.error ?? '')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /octo\/delta#4/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Restoring/)).not.toBeInTheDocument();
  });

  it('closes a failed PR with a DELETE, then drops its row', async () => {
    const server = fakeServer([ALPHA, FAILED]);
    const user = userEvent.setup();
    render(<SessionList />);

    await user.click(await screen.findByRole('button', { name: 'Close octo/delta#4' }));

    await waitFor(() => expect(screen.queryByText(FAILED.label)).not.toBeInTheDocument());
    const deletes = server.requests.filter((request) => request.method === 'DELETE');
    expect(deletes.map((request) => request.url)).toEqual(['/api/sessions/dddddddddddddddd']);
    expect(deletes[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(screen.getByText(ALPHA.label)).toBeInTheDocument();
  });

  it('turns a restoring row into a link once the server has opened the PR', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fakeServer([RESTORING]);
    render(<SessionList />);
    expect(await screen.findByText(/Restoring/)).toBeInTheDocument();

    server.open.splice(0, 1, {
      id: RESTORING.id,
      url: '/s/cccccccccccccccc/',
      prUrl: RESTORING.prUrl,
      label: RESTORING.label,
      title: 'Gamma is open',
      createdAt: '2026-11-24T07:08:09.000Z',
    });
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(await screen.findByRole('link', { name: /octo\/gamma#3/ })).toHaveAttribute(
      'href',
      '/s/cccccccccccccccc/',
    );
    expect(screen.queryByText(/Restoring/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close octo/gamma#3' })).toBeInTheDocument();
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

  it('warns at the top when the server cannot read or save the PR list', async () => {
    const server = fakeServer([ALPHA]);
    server.state.warning =
      'prs.json is not valid JSON. The PR list is not saved until the file is fixed or removed and difit restarts.';

    render(<SessionList />);

    const warning = await screen.findByText(/prs\.json is not valid JSON/);
    expect(warning).toBeInTheDocument();
    expect(screen.getByText(ALPHA.label)).toBeInTheDocument();
    expect(
      warning.compareDocumentPosition(screen.getByText(ALPHA.label)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(server.requests.some((request) => request.url === '/api/server-info')).toBe(true);
  });

  it('shows no warning when the PR list is fine', async () => {
    fakeServer([ALPHA]);

    render(<SessionList />);

    expect(await screen.findByText(ALPHA.label)).toBeInTheDocument();
    expect(screen.queryByText(/not saved/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('still lists the PRs when the server info cannot be read', async () => {
    const server = fakeServer([ALPHA]);
    server.state.serverInfoStatus = 500;

    render(<SessionList />);

    expect(await screen.findByText(ALPHA.label)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('picks up a warning that appears later, and drops it once it is gone', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fakeServer([ALPHA]);
    render(<SessionList />);
    expect(await screen.findByText(ALPHA.label)).toBeInTheDocument();
    expect(screen.queryByText(/Could not save/)).not.toBeInTheDocument();

    server.state.warning = 'Could not save the PR list: disk full';
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText(/Could not save the PR list/)).toBeInTheDocument();

    server.state.warning = undefined;
    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(screen.queryByText(/Could not save/)).not.toBeInTheDocument());
  });
});
