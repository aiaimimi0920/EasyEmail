  async function im215ResolveMailboxByEmail(cfg, email) {
    const normalized = normalizeEmailAddress(email);
    if (!normalized) throw new Error('Invalid 215.im address.');
    return { email: normalized, mailboxData: { address: normalized, email: normalized }, metadata: { manualLookup: true, selectedDomain: normalized.split('@')[1] || '' } };
  }
