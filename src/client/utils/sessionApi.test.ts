import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installSessionApiRouting, sessionApiUrl } from './sessionApi';

const SESSION = '/s/0123456789abcdef';

// The URLs that reached the browser's network APIs, recorded by stand-ins for them.
let requested: string[] = [];

class RecordingEventSource {
  constructor(url: string | URL) {
    requested.push(String(url));
  }
}

beforeEach(() => {
  requested = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response('{}');
    }),
  );
  vi.stubGlobal('EventSource', RecordingEventSource);
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: (url: string | URL) => {
      requested.push(String(url));
      return true;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'sendBeacon');
  window.history.replaceState(null, '', '/');
});

function openPage(pathname: string) {
  window.history.replaceState(null, '', pathname);
  installSessionApiRouting();
}

// Sends the URL through fetch, EventSource and sendBeacon, in that order.
function requestThroughEachApi(url: string | URL): string[] {
  requested = [];
  void fetch(url);
  new EventSource(url);
  navigator.sendBeacon(url, '');
  return requested;
}

describe('installSessionApiRouting', () => {
  it('leaves the browser APIs alone in single mode', () => {
    const singleModeFetch = window.fetch;

    openPage('/');

    expect(window.fetch).toBe(singleModeFetch);
    expect(requestThroughEachApi('/api/diff?base=HEAD%5E&target=HEAD')).toEqual(
      Array(3).fill('/api/diff?base=HEAD%5E&target=HEAD'),
    );
  });

  it.each([`${SESSION}/`, SESSION, `${SESSION}/index.html`])(
    'sends /api/ requests from %s to that session',
    (pathname) => {
      openPage(pathname);

      expect(requestThroughEachApi('/api/comments?base=stdin&target=stdin')).toEqual(
        Array(3).fill(`${SESSION}/api/comments?base=stdin&target=stdin`),
      );
      expect(requestThroughEachApi('/api/watch')).toEqual(Array(3).fill(`${SESSION}/api/watch`));
    },
  );

  it.each([
    'https://example.com/api/diff',
    'http://localhost:4969/api/watch',
    '/assets/index-abc123.js',
    '/favicon.svg',
    'api/diff',
    '/api',
    '/apis/diff',
    `${SESSION}/api/diff`,
  ])('leaves %s unchanged on a session page', (url) => {
    openPage(`${SESSION}/`);

    expect(requestThroughEachApi(url)).toEqual(Array(3).fill(url));
  });

  it('leaves URL objects unchanged on a session page', () => {
    openPage(`${SESSION}/`);
    const url = new URL('/api/diff', window.location.origin);

    expect(requestThroughEachApi(url)).toEqual(Array(3).fill(url.href));
  });

  it.each([
    '/s/',
    '/s/0123456789ABCDEF/',
    '/s/0123456789abcde/',
    '/s/0123456789abcdef0/',
    '/s/0123456789abcdeg/',
    '/s0123456789abcdef/',
    '/x/s/0123456789abcdef/',
    // Static site pages: the published site and its preview.
    '/difit/',
    '/difit/preview/',
    '/preview',
  ])('adds no prefix on %s, which is not a session page', (pathname) => {
    openPage(pathname);

    expect(requestThroughEachApi('/api/diff')).toEqual(Array(3).fill('/api/diff'));
  });
});

describe('sessionApiUrl', () => {
  it('prefixes /api/ URLs with the session of a /s/<id>/ page only', () => {
    expect(sessionApiUrl('/api/blob/a.png?ref=HEAD')).toBe('/api/blob/a.png?ref=HEAD');

    window.history.replaceState(null, '', `${SESSION}/`);

    expect(sessionApiUrl('/api/blob/a.png?ref=HEAD')).toBe(`${SESSION}/api/blob/a.png?ref=HEAD`);
    expect(sessionApiUrl('/assets/logo.svg')).toBe('/assets/logo.svg');
  });
});
