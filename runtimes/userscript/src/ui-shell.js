  function updateMiniBarVisibility() { const minimized = document.body.dataset.eepMinimized === 'true'; const panel = document.getElementById('eep-panel'); if (panel) panel.classList.toggle('is-minimized', minimized); }
  function toggleMinimize() { const next = document.body.dataset.eepMinimized === 'true' ? 'false' : 'true'; document.body.dataset.eepMinimized = next; updateMiniBarVisibility(); }
  function createPanel() {
    const existing = document.getElementById('eep-panel');
    if (existing) existing.remove();
    const settings = getSettings();
    const panel = document.createElement('section');
    panel.id = 'eep-panel';
    panel.innerHTML = `
      <div class="eep-head"><div><h1>${escapeHtml(t('title'))}</h1></div></div>
      <div class="eep-current-card"><div class="eep-current-head">${escapeHtml(t('current'))}</div><div class="eep-current-grid"><div><span>${escapeHtml(t('currentEmail'))}</span><strong class="eep-copy-value" id="eep-current-email" title="点击复制"></strong></div><div><span>${escapeHtml(t('currentCode'))}</span><strong class="eep-copy-value" id="eep-current-code" title="点击复制"></strong></div><div><span>${escapeHtml(t('currentProvider'))}</span><strong id="eep-current-provider"></strong></div><div><span>${escapeHtml(t('currentOpened'))}</span><strong id="eep-current-opened"></strong></div></div></div>
      <div class="eep-manual-card"><div class="eep-manual-head">${escapeHtml(t('manualLookup'))}</div><div class="eep-grid eep-main-grid"><label class="eep-field eep-main-span"><span>${escapeHtml(t('manualEmail'))}</span><input type="text" id="eep-manual-email" data-setting="manualQueryEmail" value="${escapeHtml(settings.manualQueryEmail || '')}" placeholder="example@mail.com" /></label></div><div class="eep-manual-actions"><div class="eep-manual-guess"><span>${escapeHtml(t('manualGuess'))}</span><strong id="eep-manual-guess">${escapeHtml(t('manualGuessUnknown'))}</strong></div><button data-action="manual-poll">${escapeHtml(t('manualPoll'))}</button></div></div>
      <div class="eep-settings-shell"><div class="eep-grid eep-main-grid"><label class="eep-field"><span>${escapeHtml(t('locale'))}</span><select data-setting="locale" id="eep-locale"><option value="zh-CN">中文</option><option value="en-US">English</option></select></label><label class="eep-field"><span>${escapeHtml(t('mode'))}</span><select data-setting="providerMode" id="eep-provider-mode"><option value="auto">${escapeHtml(t('auto'))}</option><option value="explicit">${escapeHtml(t('explicit'))}</option></select></label></div><div id="eep-row-auto" class="eep-help eep-settings-block"><span>${escapeHtml(t('providerPool'))}</span><div id="eep-selected-providers" class="eep-provider-pool"></div></div><div id="eep-row-explicit" class="eep-grid eep-main-grid"><label class="eep-field"><span>${escapeHtml(t('provider'))}</span><select data-setting="explicitProviderKey" id="eep-explicit-provider"></select></label></div><div class="eep-grid eep-main-grid"><label class="eep-field"><span>${escapeHtml(t('poll'))}</span><input type="number" min="1" data-setting="pollSeconds" value="${escapeHtml(settings.pollSeconds)}" /></label><label class="eep-field"><span>${escapeHtml(t('timeout'))}</span><input type="number" min="5" data-setting="timeoutSeconds" value="${escapeHtml(settings.timeoutSeconds)}" /></label></div><div class="eep-grid eep-main-grid"><label class="eep-field"><span>${escapeHtml(t('filter'))}</span><input type="text" data-setting="fromContains" value="${escapeHtml(settings.fromContains)}" /></label><label class="eep-field"><span>${escapeHtml(t('configProvider'))}</span><select data-setting="configProviderKey" id="eep-config-provider"></select></label></div><div id="eep-provider-settings" class="eep-provider-settings"></div></div>
      <details open><summary>${escapeHtml(t('history'))}</summary><div id="eep-history-list"></div></details>`;
    document.body.appendChild(panel);
    const explicit = document.getElementById('eep-explicit-provider'); if (explicit) { explicit.innerHTML = Object.keys(PROVIDERS).map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(providerLabel(key))}</option>`).join(''); explicit.value = settings.explicitProviderKey || DEFAULTS.explicitProviderKey; }
    const configProvider = document.getElementById('eep-config-provider'); if (configProvider) { configProvider.innerHTML = Object.keys(PROVIDERS).map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(providerLabel(key))}</option>`).join(''); configProvider.value = currentConfigProviderKey(settings); }
    document.getElementById('eep-locale').value = settings.locale || DEFAULTS.locale;
    document.getElementById('eep-provider-mode').value = settings.providerMode || DEFAULTS.providerMode;
    buildModeUi(settings); renderSelectedProviders(settings);
    const root = document.getElementById('eep-provider-settings'); if (root) root.innerHTML = renderProviderConfigForm(currentConfigProviderKey(settings), settings);
    renderMailboxSummary(); renderMailboxHistory(); renderMessages(state.currentMessages || []); renderActionState(); updateMiniSummary(); refreshManualGuess(settings.manualQueryEmail).catch(() => renderManualGuessHint(null));
  }

  function createMiniBar() { const existing = document.getElementById('eep-mini-bar'); if (existing) existing.remove(); const bar = document.createElement('div'); bar.id = 'eep-mini-bar'; bar.innerHTML = `<div class="eep-side-row"><button class="eep-side-btn" data-action="toggle-panel" title="${escapeHtml(t('settings'))}">⚙</button></div><div class="eep-side-row"><button class="eep-mini-chip" id="eep-mini-chip-email" data-copy-kind="email"></button><button class="eep-side-btn" data-action="open-mailbox" title="${escapeHtml(t('open'))}">✉</button></div><div class="eep-side-row"><button class="eep-mini-chip" id="eep-mini-chip-code" data-copy-kind="code"></button><button class="eep-side-btn" id="eep-side-poll-btn" data-action="poll-otp" title="${escapeHtml(t('pollCode'))}">码</button></div>`; document.body.appendChild(bar); renderActionState(); }

  function attachEvents() {
    [document.getElementById('eep-panel'), document.getElementById('eep-mini-bar')].filter(Boolean).forEach((root) => {
      root.addEventListener('click', async (event) => {
        const emailStrong = event.target.closest('#eep-current-email');
        if (emailStrong) {
          const mailbox = currentMailbox();
          if (mailbox && mailbox.email) {
            copyText(mailbox.email).catch(() => {});
            logLine(t('logCopyEmail'));
          }
          return;
        }
        const codeStrong = event.target.closest('#eep-current-code');
        if (codeStrong) {
          const code = state.lastCode;
          if (code) {
            copyText(code).catch(() => {});
            logLine(t('logCopyCode'));
          }
          return;
        }
        const copyChip = event.target.closest('button[data-copy-kind]');
        if (copyChip) {
          const value = String(copyChip.dataset.copyText || '').trim();
          const kind = copyChip.dataset.copyKind || '';
          if (value) {
            copyText(value).catch(() => {});
            logLine(kind === 'email' ? t('logCopyEmail') : t('logCopyCode'));
            showMiniChip(kind, value);
          }
          return;
        }
        const copyLinkButton = event.target.closest('button[data-message-link-copy]');
        if (copyLinkButton) {
          const value = String(copyLinkButton.dataset.messageLinkCopy || '').trim();
          if (value) {
            copyText(value).catch(() => {});
            logLine(t('logCopyLink'));
          }
          return;
        }
        const actionButton = event.target.closest('button[data-action]');
        if (actionButton) {
          const action = actionButton.dataset.action || '';
          if (action === 'toggle-panel') return toggleMinimize();
          if (action === 'open-mailbox') return runAction(action, async () => { updateStoredSettingsFromUi(); await openMailboxAuto(getSettings()); });
          if (action === 'manual-poll') {
            return runAction(action, async () => {
              updateStoredSettingsFromUi();
              const settings = getSettings();
              const manualEmail = String(settings.manualQueryEmail || '').trim();
              const mailbox = await ensureManualMailboxEntry(manualEmail, settings);
              await pollMailboxUntilCode(mailbox, settings);
            }, { polling: true, keepPollingState: true });
          }
          if (action === 'poll-otp') {
            if (state.polling) { state.stopRequested = true; state.polling = false; renderActionState(); return logLine(t('logPollStopped')); }
            return runAction(action, async () => { updateStoredSettingsFromUi(); const mailbox = currentMailbox(); if (!mailbox) throw new Error(t('logNoMailbox')); await pollMailboxUntilCode(mailbox, getSettings()); }, { polling: true, keepPollingState: true });
          }
        }
        const historyButton = event.target.closest('button[data-history-action]');
        if (historyButton) return onHistoryAction(historyButton.dataset.historyAction, historyButton.dataset.historyId);
        const historySelect = event.target.closest('[data-history-select]');
        if (historySelect) {
          const mailbox = state.mailboxHistory.find((item) => item.id === historySelect.dataset.historySelect);
          if (mailbox) {
            selectHistoryMailbox(mailbox, false);
            logLine(t('logHistorySelected', { email: mailbox.email }));
          }
          return;
        }
        const messageButton = event.target.closest('button[data-message-id]');
        if (messageButton) {
          const message = state.currentMessages.find((item) => item.id === messageButton.dataset.messageId);
          if (message) renderMessageDetail(message);
        }
      });
      root.addEventListener('dblclick', (event) => {
        const copyChip = event.target.closest('button[data-copy-kind]');
        if (!copyChip) return;
        const kind = copyChip.dataset.copyKind || '';
        if (kind === 'email' || kind === 'code') hideMiniChip(kind);
      });
      root.addEventListener('change', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
        if (target.dataset.setting) {
          saveSetting(target.dataset.setting, target.type === 'checkbox' ? (target.checked ? 'true' : 'false') : (target.value || ''));
          if (target.dataset.setting === 'locale') return rebuildUi();
          createPanel();
          createMiniBar();
          updateMiniBarVisibility();
          attachEvents();
          if (target.dataset.setting === 'manualQueryEmail') refreshManualGuess(target.value).catch(() => renderManualGuessHint(null));
          logLine(t('logSaved'));
          return;
        }
        if (target.dataset.providerPool) {
          updateStoredSettingsFromUi();
          createPanel();
          createMiniBar();
          updateMiniBarVisibility();
          attachEvents();
        }
      });
      root.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        if (target.dataset.setting === 'manualQueryEmail') {
          renderManualGuessHint(null);
          refreshManualGuess(target.value).catch(() => renderManualGuessHint(null));
        }
      });
    });
  }

  function installStyles() { GM_addStyle(`#eep-panel{position:fixed;top:16px;right:16px;width:420px;max-height:calc(100vh - 32px);overflow:auto;z-index:2147483000;background:linear-gradient(180deg,rgba(15,24,44,.98),rgba(11,19,34,.98));color:#edf5ff;border:1px solid rgba(120,160,255,.18);box-shadow:0 20px 60px rgba(0,0,0,.35);border-radius:20px;padding:16px;font-family:Inter,'Microsoft YaHei UI',sans-serif}#eep-panel.is-minimized{display:none}#eep-panel .eep-head{display:flex;align-items:flex-start;justify-content:flex-start;gap:12px}#eep-panel h1{margin:0;font-size:28px;line-height:1.1}#eep-panel button,#eep-mini-bar button,#eep-panel input,#eep-panel select,#eep-panel summary{font:inherit}#eep-panel button,#eep-mini-bar button{border:none;border-radius:12px;background:linear-gradient(90deg,#2563eb,#22a7f0);color:#fff;padding:10px 14px;cursor:pointer}#eep-panel button:disabled,#eep-mini-bar button:disabled{opacity:.45;cursor:not-allowed}#eep-panel details{margin-top:14px;border:1px solid rgba(130,170,255,.12);border-radius:14px;background:rgba(17,27,47,.72)}#eep-panel summary{list-style:none;cursor:pointer;padding:12px 14px;font-weight:700}#eep-panel summary::-webkit-details-marker{display:none}.eep-main-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.eep-main-span{grid-column:1/-1}.eep-field{display:flex;flex-direction:column;gap:6px;color:rgba(237,245,255,.86)}.eep-field span{font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:rgba(237,245,255,.68)}.eep-field input,.eep-field select{width:100%;box-sizing:border-box;border-radius:14px;border:1px solid rgba(130,170,255,.12);background:rgba(13,20,37,.92);color:#edf5ff;padding:12px 14px}.eep-help{justify-content:center;background:rgba(9,15,27,.66);border-radius:14px;padding:10px 14px}.eep-settings-shell,.eep-manual-card{margin-top:14px;padding:14px;border-radius:16px;background:rgba(17,27,47,.72);border:1px solid rgba(130,170,255,.12)}.eep-settings-block{margin-top:12px}.eep-manual-head,.eep-current-head{font-weight:700;margin-bottom:10px}.eep-manual-actions{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-top:12px}.eep-manual-guess{display:grid;gap:4px;min-width:0;flex:1 1 auto}.eep-manual-guess span{font-size:12px;color:rgba(237,245,255,.66);text-transform:uppercase}.eep-manual-guess strong{display:block;word-break:break-word}.eep-manual-guess strong[data-tone="warn"]{color:#ffd7a8}.eep-manual-guess strong[data-tone="success"]{color:#9ff0c0}.eep-current-card{margin-top:14px;padding:14px;border-radius:16px;background:rgba(12,19,34,.92);border:1px solid rgba(130,170,255,.12)}.eep-current-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.eep-current-grid span{display:block;color:rgba(237,245,255,.66);font-size:12px;text-transform:uppercase}.eep-current-grid strong{display:block;margin-top:4px;word-break:break-word}.eep-copy-value{cursor:pointer;transition:opacity .2s ease}.eep-copy-value:hover{opacity:.82}.eep-provider-pool{display:flex;flex-wrap:wrap;gap:8px}.eep-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:8px 10px;background:rgba(13,20,37,.92);border:1px solid rgba(130,170,255,.12)}.eep-chip small{color:rgba(237,245,255,.66);font-size:11px}.eep-chip.is-selected{border-color:rgba(61,181,255,.55);background:rgba(21,72,120,.45)}.eep-provider-settings{display:grid;gap:12px;padding:14px}.eep-provider-card{border:1px solid rgba(130,170,255,.12);border-radius:16px;background:rgba(9,15,27,.66);padding:12px}.eep-provider-card.is-configured{border-color:rgba(88,200,145,.3)}.eep-provider-card.is-unconfigured{border-color:rgba(255,170,120,.28)}.eep-provider-card.is-disabled{border-color:rgba(130,170,255,.12);opacity:.8}.eep-provider-card.is-cooling{border-color:rgba(255,215,100,.45)}.eep-provider-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.eep-provider-card-head h4{margin:0}.eep-provider-pill{display:inline-flex;align-items:center;border-radius:999px;padding:4px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;background:rgba(18,30,53,.88);border:1px solid rgba(130,170,255,.12);color:rgba(237,245,255,.78)}.eep-provider-status-note{margin:-2px 0 10px;color:rgba(237,245,255,.72);font-size:12px;line-height:1.45}.eep-provider-card-fields{display:grid;gap:10px}#eep-history-list{display:grid;gap:10px;padding:0 14px 14px;max-height:330px;overflow:auto}.eep-history-item{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;padding:12px;border-radius:14px;background:rgba(9,15,27,.66);border:1px solid rgba(130,170,255,.08)}.eep-history-item.is-current{border-color:rgba(61,181,255,.45)}.eep-history-main{flex:1 1 200px;cursor:pointer}.eep-history-email{font-weight:700;word-break:break-all}.eep-history-meta{color:rgba(237,245,255,.65);font-size:12px;margin-top:4px}.eep-history-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}.eep-history-actions button{padding:8px 10px;font-size:12px}.eep-history-message-shell{width:100%;display:grid;gap:10px;margin-top:6px}.eep-code-detail{display:grid;gap:6px;padding:12px;border-radius:14px;background:rgba(9,15,27,.66);border:1px solid rgba(130,170,255,.08)}.eep-code-value{font-size:24px;font-weight:800;letter-spacing:.04em;word-break:break-word}.eep-code-meta{font-size:12px;color:rgba(237,245,255,.66)}.eep-message-list{display:grid;gap:8px;max-height:220px;overflow:auto}.eep-message-list-inline{grid-template-columns:1fr}.eep-message-item{text-align:left;background:rgba(9,15,27,.66)}.eep-message-item.is-active{outline:2px solid rgba(61,181,255,.45)}.eep-message-item strong,.eep-message-item span{display:block}.eep-message-item span{font-size:12px;color:rgba(237,245,255,.72);margin-top:4px}.eep-raw-message{max-height:min(72vh,680px);overflow:auto;background:rgba(9,15,27,.66);border-radius:14px;padding:12px;border:1px solid rgba(130,170,255,.08)}.eep-raw-message-inline{margin-top:2px}.eep-raw-head{display:grid;gap:6px;margin-bottom:14px}.eep-raw-block{display:grid;gap:8px;margin-top:12px}.eep-raw-block-compact{margin-top:0;padding:0 12px 12px}.eep-raw-block h4{margin:0}.eep-raw-block pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;background:rgba(9,15,27,.66);border-radius:14px;padding:12px;margin:0;border:1px solid rgba(130,170,255,.08);color:#d9ebff;line-height:1.58;max-height:360px;overflow:auto}.eep-raw-body-pre{font-size:13px}.eep-raw-meta-pre{font-size:12px;color:rgba(217,235,255,.82)}.eep-raw-source-pre{font-size:12px;color:rgba(217,235,255,.78)}.eep-raw-toggle{margin-top:12px;border:1px solid rgba(130,170,255,.08);border-radius:14px;background:rgba(8,13,24,.5)}.eep-raw-toggle summary{padding:10px 12px;font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:rgba(237,245,255,.72)}.eep-empty{color:rgba(237,245,255,.66);padding:14px}#eep-mini-bar{position:fixed;right:16px;top:50%;transform:translateY(-50%);z-index:2147483001;display:flex;flex-direction:column;gap:10px;color:#fff;font-family:Inter,'Microsoft YaHei UI',sans-serif}.eep-side-row{display:flex;align-items:center;justify-content:flex-end;gap:8px}.eep-side-btn{width:30px;height:30px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:14px;padding:0;background:linear-gradient(180deg,#ffffff,#eef5ff)!important;color:#ff6a8d!important;box-shadow:0 8px 18px rgba(0,0,0,.18)}.eep-mini-chip{max-width:220px;border:none;border-radius:999px;padding:10px 14px;background:rgba(9,15,27,.94)!important;color:#edf5ff!important;box-shadow:0 14px 28px rgba(0,0,0,.28);opacity:0;transform:translateX(10px);pointer-events:none;transition:opacity .35s ease,transform .35s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.eep-mini-chip.is-visible{opacity:1;transform:translateX(0);pointer-events:auto}@media (max-width:920px){#eep-panel{width:calc(100vw - 24px);right:12px;left:12px;top:12px}.eep-main-grid,.eep-current-grid{grid-template-columns:1fr}.eep-main-span{grid-column:auto}#eep-mini-bar{right:10px}.eep-manual-actions{flex-direction:column;align-items:stretch}.eep-raw-message{max-height:min(68vh,540px)}}`); }
