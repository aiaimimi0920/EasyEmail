// Compiled only into preview bundles. Native fetch is accessed without the substituted identifier.
const blocked = () => { throw new Error('EASYEMAIL_PREVIEW_NETWORK_BLOCKED'); };

export async function previewFetch(input, init) {
  const request = new Request(input, init), url = new URL(request.url);
  if (__EASYEMAIL_PREVIEW_ORIGIN__ === null || url.protocol !== 'https:'
    || url.origin !== __EASYEMAIL_PREVIEW_ORIGIN__ || url.username || url.password) return blocked();
  // Even an approved copy must not redirect credentials or requests back to a source service.
  const response = await Reflect.get(globalThis, 'fetch').call(globalThis, new Request(request, { redirect: 'manual' }));
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return blocked(); }
  return response;
}

export const connect = blocked;
export class PreviewWebSocket { constructor() { blocked(); } }
