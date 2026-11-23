export type RootView = 'session-list' | 'review';

const isMultiServerInfo = (info: unknown): boolean =>
  typeof info === 'object' &&
  info !== null &&
  'app' in info &&
  info.app === 'difit' &&
  'mode' in info &&
  info.mode === 'multi';

// The multi-session server lists its open PRs at /, where a single-mode server shows the
// review page. Only the multi-session server answers /api/server-info.
export async function chooseRootView(): Promise<RootView> {
  if (window.location.pathname !== '/') {
    return 'review';
  }
  try {
    const response = await fetch('/api/server-info');
    return response.ok && isMultiServerInfo(await response.json()) ? 'session-list' : 'review';
  } catch {
    // Without a clear answer, keep the page / has always shown.
    return 'review';
  }
}
