import { SESSION_PATH_PATTERN } from '../../utils/sessionPath';

export function resolveEventSourceUrl(path: string): string {
  const apiUrl = import.meta.env.VITE_DIFIT_API_URL?.trim();
  // A session page's streams go through the session prefix and the Vite proxy; the
  // multi-session server refuses the Vite page's origin on a direct request.
  if (!apiUrl || SESSION_PATH_PATTERN.test(window.location.pathname)) {
    return path;
  }

  try {
    return new URL(path, apiUrl).toString();
  } catch {
    return path;
  }
}
