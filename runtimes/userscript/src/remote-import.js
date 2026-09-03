  function encodeUtf8(value) { return new TextEncoder().encode(String(value)); }
  function bytesToHex(bytes) { return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join(''); }
  function base64UrlToText(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '==='.slice((normalized.length + 3) % 4);
    return decodeURIComponent(Array.prototype.map.call(atob(padded), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
  }
  function parseImportCodePayload(importCode) {
    const text = String(importCode || '').trim();
    if (!text.startsWith(IMPORT_CODE_PREFIX)) throw new Error('Unsupported EasyEmail import code format.');
    const payload = asJson(base64UrlToText(text.slice(IMPORT_CODE_PREFIX.length)), null);
    if (!payload || payload.kind !== 'easyemail-import-code') throw new Error('Invalid EasyEmail import code payload.');
    return payload;
  }
  function encodeRfc3986(value) { return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
  function toAmzDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');
    const minute = String(date.getUTCMinutes()).padStart(2, '0');
    const second = String(date.getUTCSeconds()).padStart(2, '0');
    return `${year}${month}${day}T${hour}${minute}${second}Z`;
  }
  function toDateStamp(value) { return toAmzDate(value).slice(0, 8); }
  async function sha256Hex(value) {
    const bytes = value instanceof Uint8Array ? value : encodeUtf8(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(digest));
  }
  async function hmacSha256(keyBytes, value) {
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encodeUtf8(value));
    return new Uint8Array(signature);
  }
  async function deriveAwsV4SigningKey(secretAccessKey, dateStamp, region, service) {
    const kDate = await hmacSha256(encodeUtf8(`AWS4${secretAccessKey}`), dateStamp);
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    return hmacSha256(kService, 'aws4_request');
  }
  function buildR2ObjectUrl(importPayload, objectKey) {
    const baseUrl = normalizeUrl(importPayload.endpoint || `https://${importPayload.accountId}.r2.cloudflarestorage.com`);
    const encodedKey = String(objectKey || '').split('/').map((segment) => encodeRfc3986(segment)).join('/');
    return `${baseUrl}/${encodeRfc3986(importPayload.bucket)}/${encodedKey}`;
  }
  async function fetchR2ObjectText(importPayload, objectKey) {
    const requestUrl = buildR2ObjectUrl(importPayload, objectKey);
    const url = new URL(requestUrl);
    const host = url.host;
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = toDateStamp(now);
    const payloadHash = await sha256Hex('');
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = `GET\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;
    const signingKey = await deriveAwsV4SigningKey(String(importPayload.secretAccessKey || '').trim(), dateStamp, 'auto', 's3');
    const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));
    const authorization = `AWS4-HMAC-SHA256 Credential=${String(importPayload.accessKeyId || '').trim()}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const response = await requestTextAbsolute('GET', requestUrl, {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`R2 request failed (${response.status}) for ${objectKey}`);
    }
    return String(response.text || '');
  }
  async function fetchImportManifest(importPayload) {
    const manifestObjectKey = String(importPayload.manifestObjectKey || '').trim();
    if (!manifestObjectKey) throw new Error('Import code is missing manifestObjectKey.');
    const manifestText = await fetchR2ObjectText(importPayload, manifestObjectKey);
    const manifest = asJson(manifestText, null);
    if (!manifest || typeof manifest !== 'object') throw new Error('Failed to parse EasyEmail distribution manifest.');
    return manifest;
  }
  async function fetchUserscriptSettingsFromManifest(importPayload, manifest) {
    const userscriptBlock = readValueRecord(manifest && manifest.userscript);
    const settingsEntry = readValueRecord(userscriptBlock.settings);
    const objectKey = readValueString(settingsEntry.objectKey);
    if (!objectKey) throw new Error('Distribution manifest does not contain userscript settings objectKey.');
    const settingsText = await fetchR2ObjectText(importPayload, objectKey);
    if (readValueString(settingsEntry.sha256)) {
      const actualSha256 = await sha256Hex(settingsText);
      if (actualSha256 !== readValueString(settingsEntry.sha256)) {
        throw new Error(`Userscript settings sha256 mismatch for ${objectKey}.`);
      }
    }
    const payload = asJson(settingsText, null);
    if (!payload || payload.kind !== 'easyemail-userscript-settings') throw new Error('Downloaded userscript settings payload is invalid.');
    return {
      payload,
      fingerprint: readValueString(userscriptBlock.fingerprint) || readValueString(settingsEntry.md5) || readValueString(settingsEntry.sha256) || objectKey,
    };
  }
  function normalizeImportSyncIntervalMs(payload, existingState) {
    const candidateSeconds = Number(payload && payload.syncIntervalSeconds || existingState && existingState.syncIntervalSeconds || 7200);
    return Math.max(300, Number.isFinite(candidateSeconds) ? candidateSeconds : 7200) * 1000;
  }
  function persistImportedUserscriptSettings(importCode, importPayload, manifest, settingsPayload, fingerprint, options = {}) {
    const settingsRecord = readValueRecord(settingsPayload && settingsPayload.settings);
    Object.entries(settingsRecord).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      saveSetting(key, String(value));
    });
    const previousState = loadImportState();
    const syncEnabled = options.syncEnabled === undefined ? (typeof previousState.syncEnabled === 'boolean' ? previousState.syncEnabled : Boolean(importPayload.syncEnabled !== false)) : Boolean(options.syncEnabled);
    const syncIntervalMs = normalizeImportSyncIntervalMs(importPayload, previousState);
    saveImportState({
      importCode,
      syncEnabled,
      syncIntervalSeconds: Math.floor(syncIntervalMs / 1000),
      lastSyncedAtMs: Date.now(),
      userscriptFingerprint: fingerprint,
      manifestObjectKey: String(importPayload.manifestObjectKey || ''),
      bucket: String(importPayload.bucket || ''),
      endpoint: String(importPayload.endpoint || ''),
      releaseVersion: readValueString(manifest && manifest.releaseVersion) || readValueString(importPayload.releaseVersion),
    });
    state.providerDomainCache = {};
  }
  async function importUserscriptSettings(importCode, options = {}) {
    const payload = parseImportCodePayload(importCode);
    const manifest = await fetchImportManifest(payload);
    const settingsBundle = await fetchUserscriptSettingsFromManifest(payload, manifest);
    persistImportedUserscriptSettings(importCode, payload, manifest, settingsBundle.payload, settingsBundle.fingerprint, options);
    return {
      importCode,
      payload,
      manifest,
      userscriptFingerprint: settingsBundle.fingerprint,
      settingsCount: Object.keys(readValueRecord(settingsBundle.payload.settings)).length,
    };
  }
  async function maybeSyncImportedUserscriptSettings(reason = 'sync') {
    const importState = loadImportState();
    const importCode = String(importState.importCode || '').trim();
    if (!importCode || importState.syncEnabled === false) return null;
    const intervalMs = normalizeImportSyncIntervalMs(importState, importState);
    const lastSyncedAtMs = Number(importState.lastSyncedAtMs || 0);
    if (reason !== 'force' && lastSyncedAtMs && (Date.now() - lastSyncedAtMs) < intervalMs) return null;
    const payload = parseImportCodePayload(importCode);
    const manifest = await fetchImportManifest(payload);
    const settingsBundle = await fetchUserscriptSettingsFromManifest(payload, manifest);
    if (reason !== 'force' && String(importState.userscriptFingerprint || '') === String(settingsBundle.fingerprint || '')) {
      saveImportState({ ...importState, lastSyncedAtMs: Date.now() });
      return { updated: false, userscriptFingerprint: settingsBundle.fingerprint };
    }
    persistImportedUserscriptSettings(importCode, payload, manifest, settingsBundle.payload, settingsBundle.fingerprint, { syncEnabled: importState.syncEnabled });
    return { updated: true, userscriptFingerprint: settingsBundle.fingerprint };
  }
  function scheduleImportSyncIfNeeded() {
    if (importSyncTimer) {
      clearInterval(importSyncTimer);
      importSyncTimer = 0;
    }
    const importState = loadImportState();
    if (!String(importState.importCode || '').trim() || importState.syncEnabled === false) return;
    const intervalMs = normalizeImportSyncIntervalMs(importState, importState);
    importSyncTimer = setInterval(() => {
      maybeSyncImportedUserscriptSettings('interval').then((result) => {
        if (result && result.updated) {
          refreshRuntimeUi();
          logLine(currentLocale() === 'zh-CN' ? '已从远程同步最新导入配置。' : 'Imported settings synced from remote.');
        }
      }).catch((error) => logLine(String(error && error.message ? error.message : error || 'Import sync failed.'), 'error'));
    }, intervalMs);
  }
  function readImportCodeFromLocation() {
    try {
      const url = new URL(location.href);
      return String(
        url.searchParams.get('easyemail_import_code')
        || url.searchParams.get('easyemailImportCode')
        || url.hash.replace(/^#?easyemail_import_code=/, '')
      ).trim();
    } catch {
      return '';
    }
  }
  async function promptForImportCode(messageText) {
    const entered = window.prompt(messageText, currentImportCode() || '');
    return String(entered || '').trim();
  }
  async function promptAndImportUserscriptSettings() {
    const importCode = await promptForImportCode(currentLocale() === 'zh-CN'
      ? '请输入 EasyEmail 导入码。'
      : 'Enter your EasyEmail import code.');
    if (!importCode) return null;
    const result = await importUserscriptSettings(importCode, {});
    saveImportPromptState({});
    scheduleImportSyncIfNeeded();
    refreshRuntimeUi();
    return result;
  }
  function clearImportedUserscriptBinding() {
    saveImportState({});
    saveImportPromptState({});
    scheduleImportSyncIfNeeded();
  }
