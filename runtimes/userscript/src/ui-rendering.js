  function currentConfigProviderKey(settings) {
    const selected = String(settings.configProviderKey || DEFAULTS.configProviderKey || '').trim();
    return PROVIDERS[selected] ? selected : 'cloudflare_temp_email';
  }
  function renderProviderConfigForm(providerKey, settings) {
    const cardClass = providerCardClass(providerKey, settings);
    const hint = escapeHtml(providerRuntimeHint(providerKey, settings));
    const detail = escapeHtml(providerCardStatusDetail(providerKey, settings));
    if (providerKey === 'cloudflare_temp_email') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="cloudflare_baseUrl" value="${escapeHtml(settings.cloudflare_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('auth'))}</span><input type="password" data-setting="cloudflare_customAuth" value="${escapeHtml(settings.cloudflare_customAuth)}" /></label><label class="eep-field"><span>${escapeHtml(t('adminAuth'))}</span><input type="password" data-setting="cloudflare_adminAuth" value="${escapeHtml(settings.cloudflare_adminAuth)}" /></label><label class="eep-field"><span>${escapeHtml(t('domain'))}</span><input data-setting="cloudflare_preferredDomain" value="${escapeHtml(settings.cloudflare_preferredDomain)}" /></label></div></div>`;
    }
    if (providerKey === 'mailtm') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="mailtm_baseUrl" value="${escapeHtml(settings.mailtm_baseUrl)}" /></label></div></div>`;
    }
    if (providerKey === 'duckmail') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="duckmail_baseUrl" value="${escapeHtml(settings.duckmail_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('domain'))}</span><input data-setting="duckmail_preferredDomain" value="${escapeHtml(settings.duckmail_preferredDomain)}" /></label></div></div>`;
    }
    if (providerKey === 'guerrillamail') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="guerrillamail_apiBase" value="${escapeHtml(settings.guerrillamail_apiBase)}" /></label></div></div>`;
    }
    if (providerKey === 'tempmail-lol') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="tempmailLol_baseUrl" value="${escapeHtml(settings.tempmailLol_baseUrl)}" /></label></div></div>`;
    }
    if (providerKey === 'temporam') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="temporam_baseUrl" value="${escapeHtml(settings.temporam_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('domain'))}</span><input data-setting="temporam_preferredDomain" value="${escapeHtml(settings.temporam_preferredDomain || '')}" placeholder="v2proxy.com" /></label></div></div>`;
    }
    if (providerKey === 'etempmail') {
      const currentRecoverKey = (() => { const mb = currentMailbox(); return mb && mb.providerKey === 'etempmail' && mb.mailboxData && mb.mailboxData.recoverKey ? mb.mailboxData.recoverKey : ''; })();
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="etempmail_baseUrl" value="${escapeHtml(settings.etempmail_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('domain'))}</span><input data-setting="etempmail_preferredDomain" value="${escapeHtml(settings.etempmail_preferredDomain || '')}" placeholder="cross.edu.pl / beta.edu.pl" /></label>${currentRecoverKey ? `<label class="eep-field"><span>Recovery Key</span><input readonly value="${escapeHtml(currentRecoverKey)}" class="eep-copy-value" onclick="navigator.clipboard.writeText(this.value).catch(()=>{})" title="点击复制" style="cursor:pointer;opacity:.85" /></label>` : ''}</div></div>`;
    }
    if (providerKey === 'moemail') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="moemail_baseUrl" value="${escapeHtml(settings.moemail_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('apiKey'))}</span><input type="password" data-setting="moemail_apiKey" value="${escapeHtml(settings.moemail_apiKey)}" /></label><label class="eep-field"><span>${escapeHtml(t('expiry'))}</span><input type="number" min="60000" step="60000" data-setting="moemail_expiryTimeMs" value="${escapeHtml(settings.moemail_expiryTimeMs || '3600000')}" /></label></div></div>`;
    }
    if (providerKey === 'm2u') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="m2u_baseUrl" value="${escapeHtml(settings.m2u_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('domain'))}</span><input data-setting="m2u_preferredDomain" value="${escapeHtml(settings.m2u_preferredDomain)}" placeholder="edu.kg / cpu.edu.kg" /></label></div></div>`;
    }
    if (providerKey === 'gptmail') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="gptmail_baseUrl" value="${escapeHtml(settings.gptmail_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('apiKeys'))}</span><input type="password" data-setting="gptmail_apiKey" value="${escapeHtml(settings.gptmail_apiKey)}" /></label><label class="eep-field"><span>${escapeHtml(t('prefix'))}</span><input data-setting="gptmail_prefix" value="${escapeHtml(settings.gptmail_prefix)}" /></label></div></div>`;
    }
    if (providerKey === 'im215') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="im215_baseUrl" value="${escapeHtml(settings.im215_baseUrl)}" /></label><label class="eep-field"><span>${escapeHtml(t('apiKey'))}</span><input type="password" data-setting="im215_apiKey" value="${escapeHtml(settings.im215_apiKey)}" /></label><label class="eep-field"><span>${escapeHtml(t('domain'))}</span><input data-setting="im215_preferredDomain" value="${escapeHtml(settings.im215_preferredDomain || '')}" placeholder="007.hzeg.eu.org / example.com" /></label></div></div>`;
    }
    if (providerKey === 'mail2925') {
      return `<div class="${cardClass}"><div class="eep-provider-card-head"><h4>${escapeHtml(providerLabel(providerKey))}</h4><span class="eep-provider-pill">${hint}</span></div><div class="eep-provider-status-note">${detail}</div><div class="eep-provider-card-fields"><label class="eep-field"><span>${escapeHtml(t('url'))}</span><input data-setting="mail2925_baseUrl" value="${escapeHtml(settings.mail2925_baseUrl)}" /></label><label class="eep-field"><span>Account</span><input data-setting="mail2925_account" value="${escapeHtml(settings.mail2925_account || '')}" /></label><label class="eep-field"><span>JWT Token</span><input type="password" data-setting="mail2925_jwtToken" value="${escapeHtml(settings.mail2925_jwtToken || '')}" /></label><label class="eep-field"><span>deviceUid</span><input data-setting="mail2925_deviceUid" value="${escapeHtml(settings.mail2925_deviceUid || '')}" /></label><label class="eep-field"><span>Cookie</span><input data-setting="mail2925_cookieHeader" value="${escapeHtml(settings.mail2925_cookieHeader || '')}" /></label><label class="eep-field"><span>Folder</span><input data-setting="mail2925_folderName" value="${escapeHtml(settings.mail2925_folderName || 'Inbox')}" /></label></div></div>`;
    }
    return '';
  }
  function updateMiniSummary() { const node = document.getElementById('eep-mini-summary'); if (!node) return; const mailbox = currentMailbox(); node.textContent = !mailbox ? t('none') : (state.lastCode ? `${mailbox.email} · ${state.lastCode}` : mailbox.email); }
  function miniChipNode(kind) { return document.getElementById(`eep-mini-chip-${kind}`); }
  function hideMiniChip(kind) { const node = miniChipNode(kind); if (!node) return; node.classList.remove('is-visible'); node.textContent = ''; node.dataset.copyText = ''; }
  function showMiniChip(kind, text) { const node = miniChipNode(kind); if (!node || !text) return; node.textContent = String(text); node.dataset.copyText = String(text); node.classList.add('is-visible'); copyText(String(text)).catch(() => {}); if (miniChipTimers[kind]) clearTimeout(miniChipTimers[kind]); miniChipTimers[kind] = setTimeout(() => hideMiniChip(kind), 5000); }
  function setCurrentCode(code) { state.lastCode = String(code || '').trim(); const node = document.getElementById('eep-current-code'); if (node) node.textContent = state.lastCode || t('none'); if (!state.lastCode) hideMiniChip('code'); updateMiniSummary(); }
  function renderMailboxSummary() { const mailbox = currentMailbox(); const emailNode = document.getElementById('eep-current-email'); const providerNode = document.getElementById('eep-current-provider'); const codeNode = document.getElementById('eep-current-code'); const openedNode = document.getElementById('eep-current-opened'); if (!mailbox) { if (emailNode) emailNode.textContent = t('emptyHistory'); if (providerNode) providerNode.textContent = t('none'); if (codeNode) codeNode.textContent = state.lastCode || t('none'); if (openedNode) openedNode.textContent = t('none'); return; } if (emailNode) emailNode.textContent = mailbox.email; if (providerNode) providerNode.textContent = providerLabel(mailbox.providerKey); if (codeNode) codeNode.textContent = state.lastCode || t('none'); if (openedNode) openedNode.textContent = formatObservedAt(mailbox.openedAt); }
  function renderActionLinks(message) {
    const links = Array.isArray(message && message.actionLinks) ? message.actionLinks.filter((link) => link && link.url) : [];
    if (!links.length) return `<div class="eep-raw-block"><h4>${escapeHtml(t('rawLinks'))}</h4><pre>${escapeHtml(t('none'))}</pre></div>`;
    return `<div class="eep-raw-block"><h4>${escapeHtml(t('rawLinks'))}</h4><div style="display:grid;gap:10px;margin-top:12px;">${links.map((link) => {
      const url = String(link.url || '');
      const label = String(link.label || url);
      return `<div style="display:grid;gap:8px;padding:12px;border-radius:14px;background:rgba(9,15,27,.66);border:1px solid rgba(130,170,255,.08);"><div style="word-break:break-word;font-weight:700;">${escapeHtml(label)}</div><div style="word-break:break-all;color:rgba(217,235,255,.72);font-size:12px;">${escapeHtml(url)}</div><div style="display:flex;flex-wrap:wrap;gap:8px;"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;justify-content:center;border-radius:12px;background:linear-gradient(90deg,#2563eb,#22a7f0);color:#fff;padding:10px 14px;text-decoration:none;">${escapeHtml(t('openLink'))}</a><button type="button" data-message-link-copy="${escapeHtml(url)}">${escapeHtml(t('copyLink'))}</button></div></div>`;
    }).join('')}</div></div>`;
  }
  function renderMessageBodyBlock(title, value, preClass = '') {
    return `<div class="eep-raw-block"><h4>${escapeHtml(title)}</h4><pre class="${preClass}">${escapeHtml(String(value || '').trim() || t('none'))}</pre></div>`;
  }
  function renderHtmlSourceBlock(message) {
    const htmlBody = String(message && message.htmlBody || '').trim();
    if (!htmlBody) return '';
    return `<details class="eep-raw-toggle"><summary>${escapeHtml(t('rawHtml'))}</summary><div class="eep-raw-block eep-raw-block-compact"><pre class="eep-raw-source-pre">${escapeHtml(htmlBody)}</pre></div></details>`;
  }
  function renderInlineMessageDetail(message) {
    if (!message) return `<div class="eep-empty">${escapeHtml(t('emptyMessages'))}</div>`;
    return `<div class="eep-raw-head"><div><strong>${escapeHtml(message.subject || t('none'))}</strong></div><div>${escapeHtml(message.sender || t('none'))}</div><div>${escapeHtml(formatObservedAt(message.observedAt))}</div><div>${escapeHtml(t('rawSource'))}: ${escapeHtml(message.codeSource || t('none'))}</div></div>${renderMessageBodyBlock(t('rawText'), message.textBody, 'eep-raw-body-pre')}${renderHtmlSourceBlock(message)}${renderActionLinks(message)}${renderMessageBodyBlock(t('rawCandidates'), (message.extractedCandidates || []).join(', '), 'eep-raw-meta-pre')}`;
  }
  function renderInlineCodeDetail(mailbox) {
    const metadata = mailbox && mailbox.metadata ? mailbox.metadata : {};
    const code = String(metadata.lastCodeValue || '').trim();
    const codeObservedAt = metadata.lastCodeObservedAt ? formatObservedAt(metadata.lastCodeObservedAt) : t('none');
    if (!code) return `<div class="eep-empty">${escapeHtml(t('logReadNone'))}</div>`;
    return `<div class="eep-code-detail"><div class="eep-code-value">${escapeHtml(code)}</div><div class="eep-code-meta">${escapeHtml(codeObservedAt)}</div></div>`;
  }
  function renderMailboxHistory() {
    const root = document.getElementById('eep-history-list');
    if (!root) return;
    if (!state.mailboxHistory.length) {
      root.innerHTML = `<div class="eep-empty">${escapeHtml(t('emptyHistory'))}</div>`;
      return;
    }
    root.innerHTML = state.mailboxHistory.map((item) => {
      const isCurrent = item.id === state.currentMailboxId;
      const activeMessage = isCurrent ? (state.currentMessages.find((message) => message.id === state.currentMessageId) || state.currentMessages[0] || null) : null;
      const detailHtml = isCurrent
        ? (state.historyDetailMode === 'messages'
          ? `<div class="eep-history-message-shell">${!state.currentMessages.length ? `<div class="eep-empty">${escapeHtml(t('emptyMessages'))}</div>` : `<div class="eep-message-list eep-message-list-inline">${state.currentMessages.map((message) => `<button class="eep-message-item${message.id === (activeMessage && activeMessage.id) ? ' is-active' : ''}" data-message-id="${escapeHtml(message.id)}"><strong>${escapeHtml(message.subject || t('none'))}</strong><span>${escapeHtml(message.sender || t('none'))}</span><span>${escapeHtml(formatObservedAt(message.observedAt))}</span>${message.extractedCode ? `<span class="eep-chip">${escapeHtml(message.extractedCode)}</span>` : ''}</button>`).join('')}</div><div class="eep-raw-message eep-raw-message-inline">${renderInlineMessageDetail(activeMessage)}</div>`}</div>`
          : `<div class="eep-history-message-shell">${renderInlineCodeDetail(item)}</div>`)
        : '';
      return `<div class="eep-history-item${isCurrent ? ' is-current' : ''}"><div class="eep-history-main" data-history-select="${escapeHtml(item.id)}"><div class="eep-history-email">${escapeHtml(item.email)}</div><div class="eep-history-meta">${escapeHtml(providerLabel(item.providerKey))} · ${escapeHtml(formatObservedAt(item.openedAt))}</div></div><div class="eep-history-actions"><button data-history-action="poll" data-history-id="${escapeHtml(item.id)}">${escapeHtml(t('historyPoll'))}</button><button data-history-action="messages" data-history-id="${escapeHtml(item.id)}">${escapeHtml(t('historyMessages'))}</button></div>${detailHtml}</div>`;
    }).join('');
  }
  function renderMessages(messages) {
    state.currentMessages = Array.isArray(messages) ? messages : [];
    if (!state.currentMessages.find((message) => message.id === state.currentMessageId)) {
      state.currentMessageId = state.currentMessages[0] ? state.currentMessages[0].id : '';
    }
    renderMailboxHistory();
  }
  function renderMessageDetail(message) {
    if (!message) return;
    state.currentMessageId = message.id;
    renderMailboxHistory();
  }
  function isVisible(node) { const rect = node.getBoundingClientRect(); const style = window.getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; }
