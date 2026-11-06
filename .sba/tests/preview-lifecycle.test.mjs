import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepare } from '../prepare.mjs';
import { verifyStampedRelease } from '../release-stamp.mjs';
import { releaseInputs, sha256 } from '../../service/cloudflare/scripts/release-artifacts.mjs';
import { releaseRuntimeFixture, RELEASE_PASSWORD } from '../../service/cloudflare/tests/release-runtime-fixture.mjs';
import { mime } from '../../service/cloudflare/tests/upstream-fixture.mjs';
import { dump } from './upgrade-runtime-bridge.mjs';
import { previewRuntimeBridge } from './preview-runtime-bridge.mjs';
import { cleanupRuntimeBridge } from './cleanup-runtime-bridge.mjs';

const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => sha256(Buffer.from(JSON.stringify(canonical(value))));
function configuration(prefix, emailId, platformId) {
  const part = (role,id) => ({ name:prefix+'-'+role, origin:`https://${prefix}-${role}.synthetic-account.workers.dev`,
    database:{id,name:prefix+'-'+role+'-db'} });
  return {accountId:'a'.repeat(32),email:part('email',emailId),platform:{...part('platform',platformId),inboxBucket:prefix+'-inbox',outboxBucket:prefix+'-outbox'},
    mailDomain:prefix+'.test',routing:null,settings:{adminUsername:'admin',sendRecipients:[],providers:[],providerOrigins:[],imapEndpoints:[],smtpEndpoints:[]}};
}
async function packaged(value, config, preview, version) {
  let proofPath, proof;
  return releaseRuntimeFixture(value.descriptor,{workerSecrets:value.workers,initialize:!preview,
    async prepare(descriptor,output) {
      proof=await prepare({descriptor,providers:[],preview,metadata:{applicationId:'easyemail',applicationVersion:version,
        sourceSha:releaseInputs().head,configurationDigest:digest(config)}},output);
      proofPath=path.join(output,'sba-release.json');
      return {directory:path.join(output,'publish'),manifestSha256:sha256(await fs.readFile(proofPath))};
    },
    async verify(directory,checksum) {return verifyStampedRelease(directory,proofPath,checksum,proof.metadata);}
  });
}

test('preview then authenticated cleanup copies and removes native R2 objects while original D1/R2 remain unchanged', {timeout:300000},async()=>{
  const root=await fs.mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT,'plife-'));
  const configurations={source:configuration('test-aaaabbbbcccc','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'),
    target:configuration('test-123456abcdef','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444')};
  const configPath=path.join(root,'configurations.json');await fs.writeFile(configPath,JSON.stringify(configurations));
  const material=spawnSync('python',[path.resolve('.sba/tests/preview-data-driver.py'),'material',configPath],
    {encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(material.status,0,material.stderr);const values=JSON.parse(material.stdout);
  let source,target,bridge,cleanupBridge;
  try {
    source=await packaged(values.source,configurations.source,false,'1.0.0');
    target=await packaged(values.target,configurations.target,true,'1.0.1');
    const initialization=await source.emailRequest('/admin/db_initialize',{method:'POST',headers:{
      'x-custom-auth':JSON.parse(values.source.workers.email.PASSWORDS)[0],'x-admin-auth':JSON.parse(values.source.workers.email.ADMIN_PASSWORDS)[0]}});
    assert.equal(initialization.status,200,await initialization.clone().text());
    const user=await source.register('admin');await source.db.prepare('INSERT INTO platform_admins VALUES(?,1)').bind(user.id).run();
    const allocated=await source.allocate(user.cookie,'lifecopy');assert.equal(allocated.status,201,allocated.text);const box=allocated.body.mailbox;
    await source.deliver(box.address,mime(box.address,'463975'));
    assert.equal((await source.request(`/api/v1/mailboxes/${box.id}/sync`,{method:'POST',cookie:user.cookie,body:{}})).status,200);
    const bytes=Buffer.from('preview lifecycle attachment\0邮件'),inbox=Buffer.from('isolated raw inbox copy');
    await (await source.bucket('INBOX')).put('preview-standalone-message',inbox,{storageClass:'Standard'});
    const reserved=await source.request('/api/v1/outbox-attachments',{method:'POST',cookie:user.cookie,
      headers:{'idempotency-key':crypto.randomUUID()},body:{filename:'copy.bin',mimeType:'application/octet-stream',size:bytes.length,sha256:sha256(bytes)}});
    assert.equal(reserved.status,201,reserved.text);const attachment=reserved.body.attachment.id;
    assert.equal((await source.dispatch(`/api/v1/outbox-attachments/${attachment}/content`,{method:'PUT',body:bytes,
      headers:{Origin:configurations.source.platform.origin,Cookie:user.cookie,'content-type':'application/octet-stream'}})).status,200);
    const platformSql=await dump(source.db),emailSql=await dump(source.emailDb);
    bridge=await previewRuntimeBridge(source,target,configurations);
    const inventory=value=>{
      const row=(key,kind,remoteId,name=remoteId)=>({key,kind,accountId:value.accountId,remoteId,name});
      return [row('resource-emailDb','d1',value.email.database.id,value.email.database.name),row('resource-platformDb','d1',value.platform.database.id,value.platform.database.name),
        row('resource-inbox','r2',value.platform.inboxBucket),row('resource-outbox','r2',value.platform.outboxBucket),row('target-0','worker',value.email.name),
        row('target-1','domain',value.email.origin),row('target-2','worker',value.platform.name),row('target-3','domain',value.platform.origin)];
    };
    // Native same-code migration fixture, not a different-SHA cloud release; request-boundary tests cover that contract separately.
    const request={schemaVersion:3,taskId:'dc-'+'3'.repeat(32),action:'preview',repository:'aiaimimi0920/EasyEmail',sourceSha:releaseInputs().head,
      applicationId:'easyemail',applicationVersion:'1.0.1',environment:'test-123456abcdef',configuration:configurations.target,
      previous:{sourceSha:releaseInputs().head,applicationVersion:'1.0.0'},context:{
        source:{instanceId:'dc-'+'1'.repeat(32),taskId:'dc-'+'2'.repeat(32),sourceSha:releaseInputs().head,applicationVersion:'1.0.0',environment:'test-aaaabbbbcccc',
          configuration:configurations.source,resources:inventory(configurations.source),resultDigest:'f'.repeat(64)},
        resources:inventory(configurations.target),urls:[configurations.target.email.origin,configurations.target.platform.origin]}};
    const input=path.join(root,'input.json');await fs.writeFile(input,JSON.stringify({request,release:path.join(target.directory,'prepared'),
      sourcePort:bridge.source.port,targetPort:bridge.target.port,commandPort:bridge.port}));
    const run=await promisify(execFile)('python',[path.resolve('.sba/tests/preview-runtime-driver.py'),input,path.join(root,'operation')],
      {encoding:'utf8',windowsHide:true,timeout:180000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    const result=JSON.parse(run.stdout);assert.equal(result.status,'succeeded',run.stdout);
    assert.deepEqual(bridge.commands,['restore-email','restore-platform','migrate']);
    assert.equal(bridge.source.exports,6);assert.equal(bridge.target.exports,2);
    for (const errors of [bridge.errors,bridge.source.errors,bridge.target.errors]) assert.deepEqual(errors,[]);
    const provenance=await (await target.bucket('OUTBOX')).get('_easyemail-sba/previews/'+request.taskId+'.json');
    const record=await provenance.json();assert.equal(record.payload.resultDigest,digest(result));assert.deepEqual(record.payload.result,result);
    assert.deepEqual(await dump(source.db),platformSql);assert.deepEqual(await dump(source.emailDb),emailSql);
    assert.equal((await target.request('/api/v1/me',{cookie:user.cookie})).status,401);
    const login=await target.request('/api/v1/auth/login',{method:'POST',body:{username:'admin',password:RELEASE_PASSWORD}});assert.equal(login.status,200,login.text);
    const read=await target.dispatch(`/api/v1/outbox-attachments/${attachment}/content`,{headers:{Cookie:login.cookie}});
    assert.equal(read.status,200);assert.deepEqual(Buffer.from(await read.arrayBuffer()),bytes);
    assert.deepEqual(Buffer.from(await (await (await target.bucket('INBOX')).get('preview-standalone-message')).arrayBuffer()),inbox);
    assert.equal((await target.request(`/api/v1/mailboxes/${box.id}/sync`,{method:'POST',cookie:login.cookie,body:{}})).status,200);
    assert.equal((await target.request(`/api/v1/mailboxes/${box.id}/messages`,{cookie:login.cookie})).body.items.length,1);
    await source.checkIntegrity();await target.checkIntegrity();assert.deepEqual(source.external,[]);assert.deepEqual(target.external,[]);
    const objectIdentities=async(binding,fixture)=>(await(await fixture.bucket(binding)).list()).objects.map(row=>
      ({key:row.key,size:row.size,etag:row.etag,version:row.version,uploaded:row.uploaded.toISOString()}));
    const sourceObjects={};for(const binding of ['INBOX','OUTBOX'])sourceObjects[binding]=await objectIdentities(binding,source);
    cleanupBridge=await cleanupRuntimeBridge(target,configurations.target);
    const cleanupRequest={...request,taskId:'dc-'+'4'.repeat(32),action:'destroy-preview',
      previous:{sourceSha:request.sourceSha,applicationVersion:request.applicationVersion},context:{instanceId:request.taskId,
      previewTaskId:request.taskId,resultDigest:digest(result),resources:request.context.resources}};
    const cleanupInput=path.join(root,'cleanup-input.json');await fs.writeFile(cleanupInput,JSON.stringify({request:cleanupRequest,
      targetPort:bridge.target.port,cleanupPort:cleanupBridge.port}));
    const cleanupRun=await promisify(execFile)('python',[path.resolve('.sba/tests/cleanup-runtime-driver.py'),cleanupInput,path.join(root,'cleanup-operation')],
      {encoding:'utf8',windowsHide:true,timeout:120000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    const cleanup=JSON.parse(cleanupRun.stdout);assert.equal(cleanup.result.status,'succeeded',cleanupRun.stdout);
    assert.ok(cleanup.result.lifecycle.resources.every(row=>row.status==='removed'));
    assert.deepEqual(cleanupBridge.commands.map(row=>row.bucket),[configurations.target.platform.inboxBucket,configurations.target.platform.outboxBucket]);
    for(const binding of ['INBOX','OUTBOX']){
      assert.deepEqual((await(await target.bucket(binding)).list()).objects,[]);
      assert.deepEqual(await objectIdentities(binding,source),sourceObjects[binding]);
    }
    assert.deepEqual(await dump(source.db),platformSql);assert.deepEqual(await dump(source.emailDb),emailSql);
    assert.deepEqual(cleanupBridge.errors,[]);assert.deepEqual(bridge.target.errors,[]);
    await fs.writeFile(path.join(root,'preview-lifecycle-receipt.json'),JSON.stringify({status:'passed',cloudDeployment:false,
      cloudResourceDeletion:false,nativeR2Cleanup:true,sameCodeMigrationFixture:true,sourceUnchanged:true,dualBucketRestored:true,
      attachmentReadable:true,realMailSent:false,result,cleanup},null,2)+'\n','utf8');
    console.log('Native preview lifecycle evidence: '+root);
  } finally {try {await cleanupBridge?.close();} finally {try {await bridge?.close();} finally {try {await target?.close();} finally {await source?.close();}}}}
});
