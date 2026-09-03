  function requestAbsolute(method, url, headers, body, expectJson = true) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: headers || {},
        data: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        timeout: 30000,
        onload: (resp) => resolve({
          status: resp.status || 0,
          text: resp.responseText || '',
          data: expectJson ? asJson(resp.responseText || '', resp.responseText || '') : (resp.responseText || ''),
          headers: resp.responseHeaders || '',
        }),
        onerror: () => reject(new Error(`Network error: ${url}`)),
        ontimeout: () => reject(new Error(`Timeout: ${url}`)),
      });
    });
  }
  function requestJsonAbsolute(method, url, headers, body) { return requestAbsolute(method, url, headers, body, true); }
  function requestTextAbsolute(method, url, headers, body) { return requestAbsolute(method, url, headers, body, false); }
  function isProviderBridgeMode() {
    return String(window.name || '').startsWith('easyemail_provider_bridge_');
  }
  function providerBridgeOrigin(baseUrl) {
    try {
      return new URL(normalizeUrl(baseUrl)).origin;
    } catch {
      return '';
    }
  }
  function providerBridgeName(baseUrl) {
    const origin = providerBridgeOrigin(baseUrl);
    return `easyemail_provider_bridge_${btoa(origin).replace(/[^a-z0-9]/gi, '')}`;
  }
  function createProviderBridgePopup(baseUrl, origin) {
    const popup = window.open(`${normalizeUrl(baseUrl)}/`, providerBridgeName(baseUrl), 'popup,width=520,height=760');
    if (!popup) throw new Error(`Failed to open provider bridge window for ${origin}`);
    return { kind: 'popup', windowRef: popup, iframe: null };
  }
  function openProviderBridgePopupAtUrl(baseUrl, targetUrl) {
    const origin = providerBridgeOrigin(baseUrl);
    if (!origin) throw new Error(`Invalid provider bridge URL: ${baseUrl}`);
    const popup = window.open(String(targetUrl || `${normalizeUrl(baseUrl)}/`), providerBridgeName(baseUrl), 'popup,width=520,height=760');
    if (!popup) throw new Error(`Failed to open provider bridge window for ${origin}`);
    const target = { kind: 'popup', windowRef: popup, iframe: null };
    providerBridgeTargets.set(origin, target);
    return target;
  }
  function createProviderBridgeIframe(baseUrl) {
    const iframe = document.createElement('iframe');
    iframe.src = `${normalizeUrl(baseUrl)}/`;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';
    iframe.style.border = '0';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    (document.body || document.documentElement).appendChild(iframe);
    if (!iframe.contentWindow) {
      iframe.remove();
      return null;
    }
    return { kind: 'iframe', windowRef: iframe.contentWindow, iframe };
  }
  function ensureProviderBridgeWindow(baseUrl, mode = 'auto') {
    const origin = providerBridgeOrigin(baseUrl);
    if (!origin) throw new Error(`Invalid provider bridge URL: ${baseUrl}`);
    const existing = providerBridgeTargets.get(origin);
    if (existing) {
      if (mode === 'popup' && existing.kind === 'iframe') {
        try { existing.iframe && existing.iframe.remove(); } catch {}
        providerBridgeTargets.delete(origin);
      } else {
      if (existing.kind === 'iframe' && existing.iframe && existing.iframe.isConnected && existing.windowRef) {
        return existing;
      }
      if (existing.kind === 'popup' && existing.windowRef && !existing.windowRef.closed) {
        return existing;
      }
      }
    }
    const target = mode === 'popup'
      ? createProviderBridgePopup(baseUrl, origin)
      : (createProviderBridgeIframe(baseUrl) || createProviderBridgePopup(baseUrl, origin));
    providerBridgeTargets.set(origin, target);
    return target;
  }
  async function warmProviderBridge(baseUrl, timeoutMs = 45000, mode = 'auto') {
    const bridgeOrigin = providerBridgeOrigin(baseUrl);
    if (!bridgeOrigin || location.origin === bridgeOrigin) {
      return;
    }
    const existing = providerBridgeWarmups.get(bridgeOrigin);
    if (existing) {
      await existing;
      return;
    }
    const task = (async () => {
      try {
        await requestJsonViaProviderBridge(
          baseUrl,
          'GET',
          `${normalizeUrl(baseUrl)}/`,
          { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
          undefined,
          timeoutMs,
          mode,
        );
      } catch (error) {
        providerBridgeWarmups.delete(bridgeOrigin);
        throw error;
      }
    })();
    providerBridgeWarmups.set(bridgeOrigin, task);
    await task;
  }
  async function requestJsonViaProviderBridge(baseUrl, method, url, headers, body, timeoutMs = 45000, mode = 'auto') {
    const bridgeOrigin = providerBridgeOrigin(baseUrl);
    if (!bridgeOrigin) throw new Error(`Invalid provider bridge URL: ${baseUrl}`);
    if (location.origin === bridgeOrigin) {
      return requestJsonAbsolute(method, url, headers, body);
    }
    const bridgeTarget = ensureProviderBridgeWindow(baseUrl, mode);
    const bridgeWindow = bridgeTarget.windowRef;
    const requestId = `bridge-${Date.now()}-${randomHex(6)}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        if (retryTimer) clearInterval(retryTimer);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };
      const onMessage = (event) => {
        if (event.origin !== bridgeOrigin || event.source !== bridgeWindow) return;
        const payload = event.data || {};
        if (payload.type !== PROVIDER_BRIDGE_RESPONSE_TYPE || payload.requestId !== requestId) return;
        settled = true;
        cleanup();
        if (payload.error) {
          reject(new Error(String(payload.error)));
          return;
        }
        resolve({
          status: Number(payload.status || 0),
          data: payload.data,
          text: String(payload.text || ''),
          headers: String(payload.headers || ''),
        });
      };
      const postRequest = () => {
        try {
          bridgeWindow.postMessage({
            type: PROVIDER_BRIDGE_REQUEST_TYPE,
            requestId,
            method,
            url,
            headers: headers || {},
            body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
          }, bridgeOrigin);
        } catch {}
      };
      window.addEventListener('message', onMessage);
      const retryTimer = setInterval(() => {
        if (settled) return;
        if (bridgeTarget.kind === 'popup' && bridgeWindow.closed) {
          cleanup();
          reject(new Error(`Provider bridge window was closed for ${bridgeOrigin}`));
          return;
        }
        postRequest();
      }, 3000);
      const timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error(`Provider bridge request timed out for ${bridgeOrigin}`));
      }, timeoutMs);
      postRequest();
    });
  }
  function isCloudflareChallengeHtml(value) {
    const text = String(value || '');
    if (!text) return false;
    return /Just a moment/i.test(text) || /challenge-platform/i.test(text) || /Enable JavaScript and cookies to continue/i.test(text);
  }
  function extractCloudflareChallengePath(value) {
    const text = String(value || '');
    const match = text.match(/history\.replaceState\(null,\s*null,\s*\\?"([^"]*__cf_chl_rt_tk=[^"]+)\\?"/i);
    return match && match[1] ? match[1].replace(/\\"/g, '"') : '';
  }
  function installProviderBridgeListener() {
    window.addEventListener('message', async (event) => {
      const payload = event.data || {};
      if (payload.type !== PROVIDER_BRIDGE_REQUEST_TYPE || !payload.requestId) return;
      const source = event.source;
      const targetOrigin = event.origin || '*';
      try {
        const response = await fetch(String(payload.url || ''), {
          method: String(payload.method || 'GET').toUpperCase(),
          headers: payload.headers || {},
          body: payload.body === undefined ? undefined : String(payload.body),
          credentials: 'include',
        });
        const text = await response.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = text;
        }
        source && source.postMessage({
          type: PROVIDER_BRIDGE_RESPONSE_TYPE,
          requestId: payload.requestId,
          status: response.status,
          text,
          data,
        }, targetOrigin);
      } catch (error) {
        source && source.postMessage({
          type: PROVIDER_BRIDGE_RESPONSE_TYPE,
          requestId: payload.requestId,
          error: String(error && error.message ? error.message : error || 'Provider bridge request failed.'),
        }, targetOrigin);
      }
    });
  }
