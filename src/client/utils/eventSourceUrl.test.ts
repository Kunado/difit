import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveEventSourceUrl } from './eventSourceUrl';

describe('resolveEventSourceUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState(null, '', '/');
  });

  it('points at the API server from a single-server page under the Vite dev server', () => {
    vi.stubEnv('VITE_DIFIT_API_URL', 'http://localhost:4969');

    expect(resolveEventSourceUrl('/api/watch')).toBe('http://localhost:4969/api/watch');
  });

  it('stays relative on a /s/<id>/ page, so the session prefix and the Vite proxy apply', () => {
    vi.stubEnv('VITE_DIFIT_API_URL', 'http://localhost:4969');
    window.history.replaceState(null, '', '/s/0123456789abcdef/');

    expect(resolveEventSourceUrl('/api/heartbeat')).toBe('/api/heartbeat');
  });

  it('stays relative without an API server URL', () => {
    expect(resolveEventSourceUrl('/api/watch')).toBe('/api/watch');
  });
});
