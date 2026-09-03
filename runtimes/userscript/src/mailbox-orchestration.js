  function mailboxOpenedAtMs(mailboxEntry) { return parseDateValue(mailboxEntry && mailboxEntry.metadata && mailboxEntry.metadata.notBeforeAt || mailboxEntry && mailboxEntry.openedAt); }
  function mailboxLastCodeObservedAtMs(mailboxEntry) { return parseDateValue(mailboxEntry && mailboxEntry.metadata && mailboxEntry.metadata.lastCodeObservedAt); }
  function messageIsFreshForMailbox(message, mailboxEntry) { const observedMs = parseDateValue(message && message.observedAt); if (!observedMs) return false; const lastCodeMs = mailboxLastCodeObservedAtMs(mailboxEntry); const lastCodeMessageId = mailboxEntry && mailboxEntry.metadata && mailboxEntry.metadata.lastCodeMessageId ? String(mailboxEntry.metadata.lastCodeMessageId) : ''; if (lastCodeMs) return observedMs > lastCodeMs || (observedMs === lastCodeMs && String(message && message.id || '') !== lastCodeMessageId); const openMs = mailboxOpenedAtMs(mailboxEntry); if (!openMs) return true; return observedMs >= (openMs - 1000); }
  async function openMailboxUsingProvider(providerKey, settings) { const provider = PROVIDERS[providerKey]; logLine(t('logTryProvider', { provider: providerLabel(providerKey) })); const opened = await provider.openMailbox(provider.getConfig(settings)); const openedAt = new Date().toISOString(); const entry = { id: `${providerKey}:${Date.now()}:${randomHex(6)}`, providerKey, email: opened.email, mailboxData: opened.mailboxData, metadata: { ...(opened.metadata || {}), notBeforeAt: openedAt }, openedAt }; upsertMailbox(entry); state.currentMessages = []; state.currentMessageId = ''; state.historyDetailMode = 'code'; setCurrentCode(''); renderMessages([]); recordProviderSuccess(providerKey, 'open'); showMiniChip('email', opened.email); logLine(t('logOpen', { email: opened.email, provider: providerLabel(providerKey) })); return entry; }
  async function openMailboxAuto(settings) {
    const candidates = settings.providerMode === 'explicit' ? [settings.explicitProviderKey] : orderedProviderCandidates(settings);
    if (!candidates.length) throw new Error(t('logNoProvider'));
    for (const providerKey of candidates) {
      const provider = PROVIDERS[providerKey];
      if (!provider || !provider.isEnabled(settings) || !provider.isConfigured(settings)) continue;
      try {
        return await openMailboxUsingProvider(providerKey, settings);
      } catch (error) {
        recordProviderFailure(providerKey, error, 'open');
        logLine(t('logProviderFailed', { provider: providerLabel(providerKey), detail: String(error.message || error) }), 'error');
      }
    }
    throw new Error(t('logNoProvider'));
  }
  async function loadMailboxMessages(mailboxEntry, settings) {
    if (!mailboxEntry) throw new Error(t('logNoMailbox'));
    const provider = PROVIDERS[mailboxEntry.providerKey];
    try {
      const messages = await provider.listMessages(provider.getConfig(settings), mailboxEntry);
      const normalized = messages.filter(Boolean).sort((a, b) => (String(settings.newestFirst) === 'true' ? (Date.parse(b.observedAt || '') || 0) - (Date.parse(a.observedAt || '') || 0) : (Date.parse(a.observedAt || '') || 0) - (Date.parse(b.observedAt || '') || 0)));
      state.currentMessages = normalized;
      renderMessages(normalized);
      recordProviderSuccess(mailboxEntry.providerKey, 'read');
      logLine(t('logMessages', { count: normalized.length }));
      setJsonOutput({ provider: mailboxEntry.providerKey, messages: normalized });
      return normalized;
    } catch (error) {
      recordProviderFailure(mailboxEntry.providerKey, error, 'read');
      throw error;
    }
  }
  function selectMatchingMessage(messages, settings, mailboxEntry) { return messages.filter((message) => matchesSenderFilter(message, settings.fromContains)).filter((message) => messageIsFreshForMailbox(message, mailboxEntry)).find((message) => message.extractedCode) || null; }
  async function readMailboxOnce(mailboxEntry, settings) {
    const messages = await loadMailboxMessages(mailboxEntry, settings);
    const matched = selectMatchingMessage(messages, settings, mailboxEntry);
    if (!matched || !matched.extractedCode) {
      const hasHistoricalOnly = messages.filter((message) => matchesSenderFilter(message, settings.fromContains)).some((message) => message.extractedCode);
      state.historyDetailMode = 'code';
      renderMailboxHistory();
      return logLine(hasHistoricalOnly ? t('logReadHistoricalOnly') : t('logReadNone'));
    }
    mailboxEntry.metadata = mailboxEntry.metadata || {};
    mailboxEntry.metadata.lastCodeObservedAt = matched.observedAt || new Date().toISOString();
    mailboxEntry.metadata.lastCodeMessageId = matched.id;
    mailboxEntry.metadata.lastCodeValue = matched.extractedCode;
    upsertMailbox(mailboxEntry);
    recordProviderSuccess(mailboxEntry.providerKey, 'read');
    setCurrentCode(matched.extractedCode);
    state.historyDetailMode = 'code';
    showMiniChip('code', matched.extractedCode);
    renderMessageDetail(matched);
    logLine(t('logRead', { code: matched.extractedCode }));
    return matched;
  }
  async function pollMailboxUntilCode(mailboxEntry, settings) {
    state.polling = true;
    renderActionState();
    const pollSeconds = Math.max(1, Number.parseInt(settings.pollSeconds, 10) || 3);
    const timeoutSeconds = Math.max(1, Number.parseInt(settings.timeoutSeconds, 10) || 180);
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (!state.stopRequested) {
      const matched = await readMailboxOnce(mailboxEntry, settings);
      if (matched && matched.extractedCode) {
        state.polling = false;
        renderActionState();
        return matched;
      }
      if (Date.now() >= deadline) {
        state.polling = false;
        renderActionState();
        const timeoutError = new Error(t('logPollTimeout', { provider: providerLabel(mailboxEntry.providerKey), seconds: timeoutSeconds }));
        recordProviderFailure(mailboxEntry.providerKey, timeoutError, 'poll-timeout');
        throw timeoutError;
      }
      logLine(t('logSleep', { seconds: pollSeconds }));
      await sleep(pollSeconds * 1000);
    }
    state.polling = false;
    renderActionState();
    logLine(t('logPollStopped'));
    return null;
  }
  function selectHistoryMailbox(mailbox, clearMessages = false) {
    if (!mailbox) return;
    const changed = state.currentMailboxId !== mailbox.id;
    state.currentMailboxId = mailbox.id;
    if (changed || clearMessages) {
      state.currentMessages = [];
      state.currentMessageId = '';
    }
    saveMailboxHistory();
  }
  async function onHistoryAction(action, id) {
    const mailbox = state.mailboxHistory.find((item) => item.id === id);
    if (!mailbox) return logLine(t('logMailboxNotFound'), 'error');
    selectHistoryMailbox(mailbox, action !== 'messages');
    const settings = getSettings();
    if (action === 'poll') {
      state.historyDetailMode = 'code';
      renderMailboxHistory();
      return runAction('history-poll', () => pollMailboxUntilCode(mailbox, settings), { polling: true, keepPollingState: true });
    }
    if (action === 'messages') {
      state.historyDetailMode = 'messages';
      renderMailboxHistory();
      return runAction('history-messages', () => loadMailboxMessages(mailbox, settings));
    }
  }
