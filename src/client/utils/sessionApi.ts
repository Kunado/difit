import { SESSION_PATH_PATTERN } from '../../utils/sessionPath';

export function sessionApiUrl(url: string): string {
  const sessionPath = SESSION_PATH_PATTERN.exec(window.location.pathname)?.[0];
  return sessionPath !== undefined && url.startsWith('/api/') ? `${sessionPath}${url}` : url;
}

const routeUrl = <T>(url: string | T): string | T =>
  typeof url === 'string' ? sessionApiUrl(url) : url;

export function installSessionApiRouting(): void {
  if (!SESSION_PATH_PATTERN.test(window.location.pathname)) {
    return;
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => originalFetch(routeUrl(input), init);

  const OriginalEventSource = window.EventSource;
  window.EventSource = class extends OriginalEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(routeUrl(url), init);
    }
  };

  const originalSendBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (url, data) => originalSendBeacon(routeUrl(url), data);
}
