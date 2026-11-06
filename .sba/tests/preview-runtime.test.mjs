import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { prepare } from '../prepare.mjs';
import { previewPolicy } from '../preview-release.mjs';
import { verifyStampedRelease } from '../release-stamp.mjs';
import { releaseInputs, sha256 } from '../../service/cloudflare/scripts/release-artifacts.mjs';
import { acceptanceDeploymentFixture } from '../../service/cloudflare/tests/deployment-config-fixture.mjs';
import { releaseRuntimeFixture } from '../../service/cloudflare/tests/release-runtime-fixture.mjs';
import { mime } from '../../service/cloudflare/tests/upstream-fixture.mjs';

test('actual packaged preview retains local Web/login/mailbox APIs but rejects live mail and has no native socket import', { timeout:180000 }, async () => {
  const target = acceptanceDeploymentFixture(true);
  for (const role of ['email','platform']) {
    target[role].name = 'test-123456abcdef-' + role;
    target[role].origin = `https://${target[role].name}.synthetic-account.workers.dev`;
    target[role].database.name = target[role].name + '-db';
  }
  target.platform.inboxBucket = 'test-123456abcdef-inbox'; target.platform.outboxBucket = 'test-123456abcdef-outbox';
  let proofPath, proof;
  const fixture = await releaseRuntimeFixture(target, {
    async prepare(descriptor, output) {
      proof = await prepare({ descriptor, providers:[], preview:true, metadata:{applicationId:'easyemail',applicationVersion:'1.0.0',
        sourceSha:releaseInputs().head,configurationDigest:'c'.repeat(64)} },output);
      proofPath=path.join(output,'sba-release.json');
      return {directory:path.join(output,'publish'),manifestSha256:sha256(await fs.readFile(proofPath))};
    },
    async verify(directory,digest) { return verifyStampedRelease(directory,proofPath,digest,proof.metadata); }
  });
  try {
    assert.deepEqual(proof.previewPolicy,previewPolicy(target.email.origin));
    const home=await fixture.dispatch('/'); assert.equal(home.status,200); assert.match(await home.text(),/EasyEmail/);
    const user=await fixture.register('preview-local-user');
    const box=await fixture.allocate(user.cookie,'previewcheck'); assert.equal(box.status,201,box.text);
    const sync=await fixture.request(`/api/v1/mailboxes/${box.body.mailbox.id}/sync`,{method:'POST',cookie:user.cookie,body:{}});
    assert.equal(sync.status,200,sync.text); assert.equal(sync.body.sync.inserted,0);
    const delivered=await fixture.deliver(box.body.mailbox.address,mime(box.body.mailbox.address,'827194'));
    assert.equal(delivered.rejectReason,'EASYEMAIL_PREVIEW_EMAIL_DISABLED');
    assert.equal((await fixture.emailDb.prepare('SELECT COUNT(*) n FROM raw_mails').first()).n,0);
    for (const role of ['email','platform']) {
      const code=await fs.readFile(path.resolve(fixture.candidate,role,fixture.configs[role].main),'utf8');
      assert.doesNotMatch(code,/from ["']cloudflare:sockets["']/);
      assert.deepEqual(fixture.configs[role].triggers.crons,[]); assert.equal(fixture.configs[role].preview_urls,false);
    }
    assert.deepEqual(fixture.external,[]); await fixture.checkIntegrity();
    await fs.writeFile(path.join(fixture.directory,'preview-runtime-receipt.json'),JSON.stringify({status:'passed',cloudWrites:0,
      previewPolicy:proof.previewPolicy,localMailboxSync:true,inboundEmailRejected:true,external:fixture.external},null,2)+'\n','utf8');
    console.log('Packaged preview evidence: '+fixture.directory);
  } finally { await fixture.close(); }
});
