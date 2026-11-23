import { afterEach, describe, expect, it, vi } from 'vitest';

import { chooseRootView } from './rootView';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function stubFetch(answer: () => Promise<Response>) {
  const fetchMock = vi.fn(answer);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('chooseRootView', () => {
  it('shows the session list at / of a multi-mode server', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ app: 'difit', mode: 'multi', version: '5.0.12' }),
    );

    expect(await chooseRootView()).toBe('session-list');
    expect(fetchMock).toHaveBeenCalledWith('/api/server-info');
  });

  it.each([
    // A single-mode server has no /api/server-info; express.static answers 404.
    ['a single-mode server', async () => new Response('Not Found', { status: 404 })],
    ['a server in another mode', async () => jsonResponse({ app: 'difit', mode: 'single' })],
    ['another app', async () => jsonResponse({ app: 'other', mode: 'multi' })],
    ['a body that is not JSON', async () => new Response('<!doctype html>', { status: 200 })],
    [
      'a network failure',
      async () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ])('keeps the review page at / for %s', async (_case, answer) => {
    stubFetch(answer);

    expect(await chooseRootView()).toBe('review');
  });

  it('shows the review page on a session page without asking the server', async () => {
    window.history.replaceState(null, '', '/s/0123456789abcdef/');
    const fetchMock = stubFetch(async () => jsonResponse({ app: 'difit', mode: 'multi' }));

    expect(await chooseRootView()).toBe('review');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
