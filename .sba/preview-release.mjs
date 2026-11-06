// Preview isolation belongs to the deployment artifact, not the normal application runtime.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const network = fileURLToPath(new URL('./preview-network.mjs', import.meta.url));
const nativeNetwork = /^(?:node:)?(?:http|https|http2|net|tls|dgram|dns|undici)(?:\/|$)/;

export function previewPolicy(emailOrigin) {
  const url = new URL(emailOrigin);
  assert.equal(url.origin, emailOrigin);
  assert.equal(url.protocol, 'https:');
  assert.match(url.hostname, /^test-[a-f0-9]{12}-email\.[a-z0-9-]{1,63}\.workers\.dev$/);
  return { emailOrigin, fetchRedirects: 'manual-reject', sockets: false, websockets: false, inboundEmail: false, scheduled: false };
}

export function previewBuildOptions(role, emailOrigin) {
  assert.ok(['email', 'platform'].includes(role));
  previewPolicy(emailOrigin);
  return {
    inject: [network],
    define: { __EASYEMAIL_PREVIEW_ORIGIN__: JSON.stringify(role === 'platform' ? emailOrigin : null),
      fetch: 'previewFetch', 'globalThis.fetch': 'previewFetch',
      WebSocket: 'PreviewWebSocket', 'globalThis.WebSocket': 'PreviewWebSocket' },
    plugins: [{ name: 'easyemail-preview-network', setup(build) {
      build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: network }));
      build.onResolve({ filter: nativeNetwork }, () => { throw new Error('EASYEMAIL_PREVIEW_NATIVE_NETWORK_FORBIDDEN'); });
    } }]
  };
}
