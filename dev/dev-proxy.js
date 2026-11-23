/**
 * The Origin the Vite dev proxy sends to the difit API server. The page's own requests
 * carry the Vite origin, which the multi-session server refuses as cross-origin; they
 * pass as the API server's origin. A foreign origin is kept, so the server still refuses it.
 *
 * @param {{ origin: string | undefined; host: string | undefined; target: string }} request
 * @returns {string | undefined}
 */
export function originForApiServer({ origin, host, target }) {
  return origin !== undefined && origin === `http://${host}` ? new URL(target).origin : origin;
}
