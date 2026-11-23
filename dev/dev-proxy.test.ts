import { describe, expect, it } from 'vitest';

import { originForApiServer } from './dev-proxy.js';

describe('originForApiServer', () => {
  const target = 'http://localhost:4966';

  it("passes the Vite page's own requests as the API server's origin", () => {
    expect(
      originForApiServer({ origin: 'http://localhost:5173', host: 'localhost:5173', target }),
    ).toBe('http://localhost:4966');
  });

  it('keeps a foreign origin, so the API server still refuses it', () => {
    expect(
      originForApiServer({ origin: 'https://evil.example', host: 'localhost:5173', target }),
    ).toBe('https://evil.example');
  });

  it('leaves a request without an origin without one', () => {
    expect(
      originForApiServer({ origin: undefined, host: 'localhost:5173', target }),
    ).toBeUndefined();
  });
});
