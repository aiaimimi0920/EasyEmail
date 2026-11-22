import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepare } from '../prepare.mjs';
import { verifyStampedRelease } from '../release-stamp.mjs';
import { previewRuntime } from '../preview-vault.mjs';
import { releaseInputs, sha256 } from '../../service/cloudflare/scripts/release-artifacts.mjs';
import { releaseRuntimeFixture, RELEASE_PASSWORD } from '../../service/cloudflare/tests/release-runtime-fixture.mjs';
import { mime } from '../../service/cloudflare/tests/upstream-fixture.mjs';
import { migrationStatements } from '../../service/cloudflare/tests/migration-sql.mjs';
import { dump } from './upgrade-runtime-bridge.mjs';

const driver = path.resolve('.sba/tests/preview-data-driver.py');
function configuration(prefix, emailId, platformId) {
  const part = (role,id) => ({ name: prefix+'-'+role, origin:`https://${prefix}-${role}.synthetic-account.workers.dev`,
    database:{id,name:prefix+'-'+role+'-db'} });
  return { accountId:'a'.repeat(32), email:part('email',emailId),platform:{...part('platform',platformId),inboxBucket:prefix+'-inbox',outboxBucket:prefix+'-outbox'},
    mailDomain:prefix+'.test',routing:null,settings:{adminUsername:'admin',sendRecipients:[],providers:[],providerOrigins:[],imapEndpoints:[],smtpEndpoints:[]} };
}

async function packaged(value, preview, initialize) {
  let proofPath, proof;
  return releaseRuntimeFixture(value.descriptor, {workerSecrets:value.workers,initialize,
    async prepare(descriptor,output) {
      proof=await prepare({descriptor,providers:[],preview,metadata:{applicationId:'easyemail',applicationVersion:'1.0.0',
        sourceSha:releaseInputs().head,configurationDigest:'d'.repeat(64)}},output);
      proofPath=path.join(output,'sba-release.json');
      return {directory:path.join(output,'publish'),manifestSha256:sha256(await fs.readFile(proofPath))};
    },
    async verify(directory,digest) {return verifyStampedRelease(directory,proofPath,digest,proof.metadata);}
  });
}

async function importSnapshot(database,sql) {
  const statements=migrationStatements(sql).filter(statement=>!/^\s*(?:BEGIN TRANSACTION|COMMIT)\s*;?\s*$/i.test(statement));
  await database.batch([database.prepare('PRAGMA defer_foreign_keys=ON'),...statements.map(statement=>database.prepare(statement))]);
}

test('native clone preserves old mail/passwords, revokes source sessions and re-signs self credentials without changing the source', {timeout:240000},async()=>{
  const root=await fs.mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT,'pcopy-'));
  const configs={source:configuration('test-aaaabbbbcccc','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'),
    target:configuration('test-123456abcdef','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444')};
  const configPath=path.join(root,'configurations.json');await fs.writeFile(configPath,JSON.stringify(configs),'utf8');
  const material=spawnSync('python',[driver,'material',configPath],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(material.status,0,material.stderr);const values=JSON.parse(material.stdout);
  let source,target;
  try {
    source=await packaged(values.source,false,true);target=await packaged(values.target,true,false);
    assert.deepEqual((await target.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*'").all()).results,[]);
    const user=await source.register('admin');
    await source.db.prepare('INSERT INTO platform_admins(user_id,created_at) VALUES(?,1)').bind(user.id).run();
    const allocated=await source.allocate(user.cookie,'oldmail');assert.equal(allocated.status,201,allocated.text);
    const box=allocated.body.mailbox;
    await source.deliver(box.address,mime(box.address,'629175'));
    assert.equal((await source.request(`/api/v1/mailboxes/${box.id}/sync`,{method:'POST',cookie:user.cookie,body:{}})).status,200);
    const config=JSON.parse(source.configs.platform.vars.PROVIDER_CONFIG)[0];
    await source.db.prepare("INSERT INTO provider_overrides(id,config_json,revision,secret_source,change_token,updated_at) VALUES('self',?,1,'environment','local-preview-config',1)").bind(JSON.stringify(config)).run();
    const originalMailbox=await source.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(box.id).first();
    const originalHash=(await source.db.prepare('SELECT password_hash FROM users WHERE id=?').bind(user.id).first()).password_hash;
    const platformSql=await dump(source.db),emailSql=await dump(source.emailDb);
    const sourcePath=path.join(root,'source.sql'),targetPath=path.join(root,'target.sql');await fs.writeFile(sourcePath,platformSql);
    const rewritten=await promisify(execFile)('python',[driver,'prepare',configPath,sourcePath,targetPath],
      {encoding:'utf8',windowsHide:true,timeout:120000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    assert.deepEqual(JSON.parse(rewritten.stdout),{selfCredentials:1,providerOverrides:1});
    assert.deepEqual(await fs.readFile(sourcePath),platformSql);
    await importSnapshot(target.emailDb,emailSql.toString('utf8'));await importSnapshot(target.db,await fs.readFile(targetPath,'utf8'));
    assert.deepEqual(await target.reapplyMigrations(),[]);
    assert.equal((await target.request('/api/v1/me',{cookie:user.cookie})).status,401);
    const login=await target.request('/api/v1/auth/login',{method:'POST',body:{username:'admin',password:RELEASE_PASSWORD}});
    assert.equal(login.status,200,login.text);
    const items=await target.request(`/api/v1/mailboxes/${box.id}/messages`,{cookie:login.cookie});
    assert.equal(items.status,200,items.text);assert.equal(items.body.items.length,1);
    const sync=await target.request(`/api/v1/mailboxes/${box.id}/sync`,{method:'POST',cookie:login.cookie,body:{}});
    assert.equal(sync.status,200,sync.text);assert.equal(sync.body.sync.inserted,0);
    assert.equal((await target.db.prepare('SELECT password_hash FROM users WHERE id=?').bind(user.id).first()).password_hash,originalHash);
    const runtime=await previewRuntime(),old=await runtime.decryptCredential(values.source.workers.platform,originalMailbox,originalMailbox.credential_cipher);
    const oldToken=await target.emailRequest('/api/parsed_mails?limit=1&offset=0',{headers:{authorization:'Bearer '+old.token,
      'x-custom-auth':JSON.parse(values.target.workers.email.PASSWORDS)[0]}});
    assert.equal(oldToken.status,401);
    assert.deepEqual(await dump(source.db),platformSql);assert.deepEqual(await dump(source.emailDb),emailSql);
    await source.checkIntegrity();await target.checkIntegrity();assert.deepEqual(source.external,[]);assert.deepEqual(target.external,[]);
    await fs.writeFile(path.join(root,'preview-copy-receipt.json'),JSON.stringify({status:'passed',cloudDeployment:false,sourceUnchanged:true,
      originalPasswordPreserved:true,originalMailReadable:true,sourceSessionRevoked:true,sourceSigningKeyRejected:true,selfSyncOnCopy:true,realMailSent:false},null,2)+'\n','utf8');
    console.log('Native preview copy evidence: '+root);
  } finally {try {await target?.close();} finally {await source?.close();}}
});
