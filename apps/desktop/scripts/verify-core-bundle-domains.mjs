export async function verifyBundledCoreRelationalDomains({
  baseUrl,
  apiToken,
  fakeAccountSecret,
}) {
  const unauthorizedContacts = await fetch(`${baseUrl}/mail/contacts`);
  await unauthorizedContacts.arrayBuffer();
  if (unauthorizedContacts.status !== 401) {
    throw new Error(`Expected unauthenticated contacts to return 401, got ${unauthorizedContacts.status}.`);
  }
  const unauthorizedTaxonomy = await fetch(`${baseUrl}/mail/taxonomy?kind=folder`);
  await unauthorizedTaxonomy.arrayBuffer();
  if (unauthorizedTaxonomy.status !== 401) {
    throw new Error(`Expected unauthenticated taxonomy to return 401, got ${unauthorizedTaxonomy.status}.`);
  }
  const unauthorizedAccounts = await fetch(`${baseUrl}/mail/accounts`);
  await unauthorizedAccounts.arrayBuffer();
  if (unauthorizedAccounts.status !== 401) {
    throw new Error(`Expected unauthenticated accounts to return 401, got ${unauthorizedAccounts.status}.`);
  }
  const unauthorizedMessages = await fetch(`${baseUrl}/mail/messages?scope=anonymous`);
  await unauthorizedMessages.arrayBuffer();
  if (unauthorizedMessages.status !== 401) {
    throw new Error(`Expected unauthenticated messages to return 401, got ${unauthorizedMessages.status}.`);
  }
  const unauthorizedVerifications = await fetch(`${baseUrl}/mail/verifications`);
  await unauthorizedVerifications.arrayBuffer();
  if (unauthorizedVerifications.status !== 401) {
    throw new Error(`Expected unauthenticated verifications to return 401, got ${unauthorizedVerifications.status}.`);
  }
  const unauthorizedSendQueue = await fetch(`${baseUrl}/mail/send-queue`);
  await unauthorizedSendQueue.arrayBuffer();
  if (unauthorizedSendQueue.status !== 401) {
    throw new Error(`Expected unauthenticated send queue to return 401, got ${unauthorizedSendQueue.status}.`);
  }

  const contactCreate = await fetch(`${baseUrl}/mail/contacts`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "Packaged core contact",
      emailAddress: "packaged-core@example.test",
    }),
  });
  if (!contactCreate.ok) {
    throw new Error(`Authenticated packaged-core contact create failed with status ${contactCreate.status}.`);
  }
  const contactPayload = await contactCreate.json();
  if (
    contactPayload?.contact?.displayName !== "Packaged core contact"
    || contactPayload?.contact?.emailAddress !== "packaged-core@example.test"
    || contactPayload?.contact?.version !== 1
  ) {
    throw new Error("Authenticated packaged-core contact create returned an invalid canonical result.");
  }
  const contactsList = await fetch(`${baseUrl}/mail/contacts`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  const contactsPayload = await contactsList.json();
  if (
    !contactsList.ok
    || contactsPayload?.contacts?.length !== 1
    || contactsPayload.contacts[0]?.id !== contactPayload.contact.id
  ) {
    throw new Error("Authenticated packaged-core contact list did not read the created contact.");
  }

  const rawSecretAccount = await fetch(`${baseUrl}/mail/accounts`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "normal_long_lived",
      displayName: "Rejected account",
      primaryAddress: "rejected-account@example.test",
      password: fakeAccountSecret,
    }),
  });
  const rawSecretPayload = await rawSecretAccount.json();
  if (
    rawSecretAccount.status !== 400
    || rawSecretPayload?.code !== "ACCOUNT_CREDENTIAL_REF_SECRET_FORBIDDEN"
    || JSON.stringify(rawSecretPayload).includes(fakeAccountSecret)
  ) {
    throw new Error("Packaged core did not reject raw account secret material safely.");
  }

  const accountCreate = await fetch(`${baseUrl}/mail/accounts`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "normal_long_lived",
      displayName: "Packaged core account",
      primaryAddress: "packaged-core-account@example.test",
      imap: {
        host: "imap.example.test",
        port: 993,
        security: "tls",
        username: "packaged-core-account@example.test",
      },
      smtp: {
        host: "smtp.example.test",
        port: 465,
        security: "tls",
        username: "packaged-core-account@example.test",
      },
      credentialRefs: [
        {
          secretBackend: "fake-vault",
          secretKey: "ref:v1:packaged-core/imap",
          credentialKind: "imap_password",
          authMethod: "password",
        },
        {
          secretBackend: "fake-vault",
          secretKey: "ref:v1:packaged-core/smtp",
          credentialKind: "smtp_password",
          authMethod: "password",
        },
      ],
    }),
  });
  if (!accountCreate.ok) {
    throw new Error(`Authenticated packaged-core account create failed with status ${accountCreate.status}.`);
  }
  const accountPayload = await accountCreate.json();
  if (
    accountPayload?.account?.displayName !== "Packaged core account"
    || accountPayload?.account?.imap?.protocol !== "imap"
    || accountPayload?.account?.imap?.host !== "imap.example.test"
    || accountPayload?.account?.credentialRefs?.[0]?.secretKey !== "ref:v1:packaged-core/imap"
    || accountPayload?.account?.credentialRefs?.[0]?.status !== "missing"
  ) {
    throw new Error("Authenticated packaged-core account create returned an invalid canonical result.");
  }
  const accountsList = await fetch(`${baseUrl}/mail/accounts?scope=normal`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  const accountsPayload = await accountsList.json();
  if (
    !accountsList.ok
    || !accountsPayload?.accounts?.some((account) => account.id === "acct_anonymous_virtual")
    || !accountsPayload?.accounts?.some((account) => account.id === accountPayload.account.id)
  ) {
    throw new Error("Authenticated packaged-core account list did not preserve normal visibility semantics.");
  }
  const imapTest = await fetch(`${baseUrl}/mail/accounts/imap/test`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      accountId: accountPayload.account.id,
      credentialRefId: accountPayload.account.credentialRefs[0].id,
    }),
  });
  const imapTestPayload = await imapTest.json();
  if (
    imapTest.status !== 503
    || imapTestPayload?.code !== "ACCOUNT_CREDENTIAL_UNAVAILABLE"
    || JSON.stringify(imapTestPayload).includes(fakeAccountSecret)
  ) {
    throw new Error("Packaged core IMAP test did not fail closed without a credential resolver.");
  }
  const smtpCredentialRef = accountPayload.account.credentialRefs.find(
    (ref) => ref.credentialKind === "smtp_password",
  );
  const smtpTest = await fetch(`${baseUrl}/mail/accounts/smtp/test`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      accountId: accountPayload.account.id,
      credentialRefId: smtpCredentialRef.id,
    }),
  });
  const smtpTestPayload = await smtpTest.json();
  if (
    smtpTest.status !== 503
    || smtpTestPayload?.code !== "ACCOUNT_CREDENTIAL_UNAVAILABLE"
    || JSON.stringify(smtpTestPayload).includes(fakeAccountSecret)
  ) {
    throw new Error("Packaged core SMTP test did not fail closed without a credential resolver.");
  }

  const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
  const enqueueSend = await fetch(`${baseUrl}/mail/send-queue`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "Idempotency-Key": "packaged-core-scheduled-1",
    },
    body: JSON.stringify({
      accountId: accountPayload.account.id,
      targetAddress: "scheduled-recipient@example.test",
      scheduledAt,
      subject: "Packaged scheduled send",
      bodyText: "Scheduled body text",
    }),
  });
  const enqueuePayload = await enqueueSend.json();
  if (
    !enqueueSend.ok
    || enqueuePayload?.deduplicated !== false
    || enqueuePayload?.queueItem?.status !== "queued"
  ) {
    throw new Error("Packaged-core scheduled send enqueue returned an invalid canonical result.");
  }
  const reopenScheduled = await fetch(
    `${baseUrl}/mail/messages/${enqueuePayload.messageId}/scheduled-send/reopen`,
    { method: "POST", headers: { authorization: `Bearer ${apiToken}` } },
  );
  const reopenPayload = await reopenScheduled.json();
  if (
    !reopenScheduled.ok
    || reopenPayload?.queueItem?.status !== "cancelled"
    || reopenPayload?.message?.localFolder !== "drafts"
  ) {
    throw new Error("Packaged-core scheduled send reopen did not cancel queue item and restore draft.");
  }

  const taxonomyCreate = await fetch(`${baseUrl}/mail/taxonomy/folder/packaged_core`, {
    method: "PUT",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Packaged core", color: "#8b5cf6" }),
  });
  if (!taxonomyCreate.ok) {
    throw new Error(`Authenticated packaged-core taxonomy create failed with status ${taxonomyCreate.status}.`);
  }
  const taxonomyPayload = await taxonomyCreate.json();
  if (
    taxonomyPayload?.item?.name !== "Packaged core"
    || taxonomyPayload?.item?.kind !== "folder"
    || taxonomyPayload?.item?.version !== 1
    || taxonomyPayload?.capabilities?.messageReferencePropagation !== false
  ) {
    throw new Error("Authenticated packaged-core taxonomy create returned an invalid canonical result.");
  }
  const taxonomyList = await fetch(`${baseUrl}/mail/taxonomy?kind=folder`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  const taxonomyListPayload = await taxonomyList.json();
  if (
    !taxonomyList.ok
    || taxonomyListPayload?.items?.length !== 1
    || taxonomyListPayload.items[0]?.id !== taxonomyPayload.item.id
  ) {
    throw new Error("Authenticated packaged-core taxonomy list did not read the created folder.");
  }

  const draftSave = await fetch(`${baseUrl}/mail/drafts`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      accountId: accountPayload.account.id,
      targetAddress: "recipient@example.test",
      subject: "Packaged verification code",
      bodyText: "Your verification code is 654321.",
      bodyHtml: '<p onclick="evil()">Your verification code is 654321.</p><script>evil()</script>',
    }),
  });
  const draftPayload = await draftSave.json();
  if (!draftSave.ok || !draftPayload?.draft?.messageId) {
    throw new Error(`Authenticated packaged-core draft save failed with status ${draftSave.status}.`);
  }
  const messageDetail = await fetch(`${baseUrl}/mail/messages/${draftPayload.draft.messageId}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  const detailPayload = await messageDetail.json();
  if (
    !messageDetail.ok
    || detailPayload?.message?.localFolder !== "drafts"
    || detailPayload?.message?.bodyHtml?.includes("<script")
    || detailPayload?.message?.bodyHtml?.includes("onclick")
  ) {
    throw new Error("Packaged-core message detail did not return a sanitized local draft.");
  }
  const reclassify = await fetch(
    `${baseUrl}/mail/messages/${draftPayload.draft.messageId}/reclassify-verification`,
    { method: "POST", headers: { authorization: `Bearer ${apiToken}` } },
  );
  const reclassifyPayload = await reclassify.json();
  const verificationsList = await fetch(`${baseUrl}/mail/verifications?limit=10`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  const verificationsPayload = await verificationsList.json();
  if (
    !reclassify.ok
    || reclassifyPayload?.verification?.code !== "654321"
    || !verificationsList.ok
    || !verificationsPayload?.verifications?.some((item) => item.code === "654321")
  ) {
    throw new Error("Packaged-core verification extraction or query did not persist canonical code.");
  }
}
