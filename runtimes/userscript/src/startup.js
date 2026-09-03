  async function bootstrapImportFlow() {
    const locationImportCode = readImportCodeFromLocation();
    if (locationImportCode) {
      const imported = await importUserscriptSettings(locationImportCode, {});
      logLine(currentLocale() === 'zh-CN'
        ? `已通过 URL 参数导入 ${imported.settingsCount} 项远程配置。`
        : `Imported ${imported.settingsCount} remote settings from URL parameter.`);
      scheduleImportSyncIfNeeded();
      refreshRuntimeUi();
      return;
    }

    const existingImportCode = currentImportCode();
    if (existingImportCode) {
      const syncResult = await maybeSyncImportedUserscriptSettings('boot');
      scheduleImportSyncIfNeeded();
      if (syncResult && syncResult.updated) {
        logLine(currentLocale() === 'zh-CN' ? '已同步最新导入配置。' : 'Imported settings synced.');
        refreshRuntimeUi();
      }
      return;
    }

    if (hasAnyStoredUserSettings()) return;
    const promptState = loadImportPromptState();
    if (promptState && promptState.dismissed) return;
    const enteredImportCode = await promptForImportCode(currentLocale() === 'zh-CN'
      ? '当前没有远程导入配置。请输入 EasyEmail 导入码，或直接取消后手动配置。'
      : 'No remote import config is set. Enter your EasyEmail import code, or cancel to configure manually.');
    if (!enteredImportCode) {
      saveImportPromptState({ dismissed: true, dismissedAtMs: Date.now() });
      return;
    }
    const imported = await importUserscriptSettings(enteredImportCode, {});
    saveImportPromptState({});
    scheduleImportSyncIfNeeded();
    refreshRuntimeUi();
    logLine(currentLocale() === 'zh-CN'
      ? `已导入 ${imported.settingsCount} 项远程配置。`
      : `Imported ${imported.settingsCount} remote settings.`);
  }
  function maybeRegisterMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('EasyEmail Runtime: 切换面板', () => toggleMinimize());
    GM_registerMenuCommand(currentLocale() === 'zh-CN' ? 'EasyEmail Runtime: 导入/替换导入码' : 'EasyEmail Runtime: Import or replace code', () => {
      promptAndImportUserscriptSettings().then((result) => {
        if (result) logLine(currentLocale() === 'zh-CN' ? '导入码已更新。' : 'Import code updated.');
      }).catch((error) => logLine(String(error && error.message ? error.message : error || 'Import failed.'), 'error'));
    });
    GM_registerMenuCommand(currentLocale() === 'zh-CN' ? 'EasyEmail Runtime: 立即同步导入配置' : 'EasyEmail Runtime: Sync imported config now', () => {
      maybeSyncImportedUserscriptSettings('force').then((result) => {
        if (result && result.updated) {
          refreshRuntimeUi();
          logLine(currentLocale() === 'zh-CN' ? '已同步最新导入配置。' : 'Imported settings synced.');
        } else {
          logLine(currentLocale() === 'zh-CN' ? '远程导入配置没有变化。' : 'Remote imported settings are unchanged.');
        }
      }).catch((error) => logLine(String(error && error.message ? error.message : error || 'Sync failed.'), 'error'));
    });
    GM_registerMenuCommand(readImportSyncEnabled()
      ? (currentLocale() === 'zh-CN' ? 'EasyEmail Runtime: 关闭导入配置自动同步' : 'EasyEmail Runtime: Disable import auto-sync')
      : (currentLocale() === 'zh-CN' ? 'EasyEmail Runtime: 开启导入配置自动同步' : 'EasyEmail Runtime: Enable import auto-sync'), () => {
      const stateRecord = loadImportState();
      saveImportState({ ...stateRecord, syncEnabled: !readImportSyncEnabled() });
      scheduleImportSyncIfNeeded();
      logLine(readImportSyncEnabled()
        ? (currentLocale() === 'zh-CN' ? '已开启导入配置自动同步。' : 'Import auto-sync enabled.')
        : (currentLocale() === 'zh-CN' ? '已关闭导入配置自动同步。' : 'Import auto-sync disabled.'));
    });
    GM_registerMenuCommand(currentLocale() === 'zh-CN' ? 'EasyEmail Runtime: 清除导入码绑定' : 'EasyEmail Runtime: Clear import code binding', () => {
      clearImportedUserscriptBinding();
      logLine(currentLocale() === 'zh-CN' ? '已清除导入码绑定，当前配置已保留。' : 'Import code binding cleared. Current settings were kept.');
    });
  }
  function installDebugHooks() {
    try {
      window.__easyEmailDebug = {
        snapshot() {
          const mailbox = currentMailbox();
          const settings = getSettings();
          const matched = mailbox ? selectMatchingMessage(state.currentMessages || [], settings, mailbox) : null;
          return {
            currentMailboxId: state.currentMailboxId,
            currentMailbox: mailbox ? JSON.parse(JSON.stringify(mailbox)) : null,
            currentMessages: JSON.parse(JSON.stringify(state.currentMessages || [])),
            currentCode: state.lastCode,
            historyDetailMode: state.historyDetailMode,
            matchedMessage: matched ? JSON.parse(JSON.stringify(matched)) : null,
            providerStats: JSON.parse(JSON.stringify(state.providerStats || {})),
          };
        },
        extractOtp(input) {
          return extractOtpFromContent(input || {});
        },
        explainExtract(input) {
          const payload = input || {};
          const contextualShortOtp = extractContextualShortOtp(payload);
          const contextualNumericOtp = extractContextualNumericOtp(payload);
          const counts = collectOccurrences(payload);
          const candidates = [
            ...extractCandidates(payload.subject, 'subject', counts, counts.size),
            ...extractCandidates(payload.textBody, 'text', counts, counts.size),
            ...extractCandidates(payload.htmlBody, 'html', counts, counts.size),
          ];
          return {
            contextualShortOtp,
            contextualNumericOtp,
            candidates,
            extracted: extractOtpFromContent(payload),
          };
        },
      };
    } catch {}
  }
  async function bootstrap() {
    if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function' || typeof GM_xmlhttpRequest !== 'function') { console.warn('EasyEmail Runtime userscript requires GM_* APIs.'); return; }
    if (isProviderBridgeMode()) {
      installProviderBridgeListener();
      return;
    }
    seedMissingSettings();
    state.currentMailboxId = String(loadSetting('currentMailboxId') || '');
    state.mailboxHistory = loadJson('mailboxHistory', []);
    state.providerStats = loadJson('providerStats', {});
    state.historyDetailMode = 'code';
    document.body.dataset.eepMinimized = 'true';
    installStyles();
    createPanel();
    createMiniBar();
    updateMiniBarVisibility();
    attachEvents();
    installDebugHooks();
    maybeRegisterMenu();
    setStatus(t('ready'));
    hideMiniChip('email');
    hideMiniChip('code');
    await bootstrapImportFlow();
    logLine(t('ready'));
  }
  bootstrap().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[EasyEmail Runtime] bootstrap failed:', error);
    try { logLine(message, 'error'); } catch {}
  });
