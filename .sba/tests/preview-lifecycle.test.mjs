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

for (const repairing of [false,true]) test((repairing?'partial preview then independent repair':'preview')+' and authenticated cleanup preserve original native D1/R2', {timeout:300000},async()=>{
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
    const initialVersion=repairing?'1.0.2':'1.0.1';
    target=await packaged(values.target,configurations.target,true,initialVersion);
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
    let candidate;
    if(repairing){
      const directory=path.join(root,'candidate');
      const proof=await prepare({descriptor:values.target.descriptor,providers:[],preview:true,metadata:{applicationId:'easyemail',
        applicationVersion:'1.0.4',sourceSha:releaseInputs().head,configurationDigest:digest(configurations.target)}},directory);
      const proofPath=path.join(directory,'sba-release.json'),checksum=sha256(await fs.readFile(proofPath));
      candidate={directory,proof,proofPath,checksum};
      await verifyStampedRelease(path.join(directory,'publish'),proofPath,checksum,proof.metadata);
    }
    bridge=await previewRuntimeBridge(source,target,configurations,repairing?{async publish(role){
      // CLI publication is a fixture, but both sealed candidate Workers really replace the original runtime.
      if(role==='platform'){
        await fs.cp(path.join(candidate.directory,'publish'),target.candidate,{recursive:true});await target.restart();
      }
    }}:{});
    const inventory=value=>{
      const row=(key,kind,remoteId,name=remoteId)=>({key,kind,accountId:value.accountId,remoteId,name});
      return [row('resource-emailDb','d1',value.email.database.id,value.email.database.name),row('resource-platformDb','d1',value.platform.database.id,value.platform.database.name),
        row('resource-inbox','r2',value.platform.inboxBucket),row('resource-outbox','r2',value.platform.outboxBucket),row('target-0','worker',value.email.name),
        row('target-1','domain',value.email.origin),row('target-2','worker',value.platform.name),row('target-3','domain',value.platform.origin)];
    };
    // Native same-code migration fixture, not a different-SHA cloud release; request-boundary tests cover that contract separately.
    let request={schemaVersion:3,taskId:'dc-'+'3'.repeat(32),action:'preview',repository:'aiaimimi0920/EasyEmail',sourceSha:releaseInputs().head,
      applicationId:'easyemail',applicationVersion:initialVersion,environment:'test-123456abcdef',configuration:configurations.target,
      previous:{sourceSha:releaseInputs().head,applicationVersion:'1.0.0'},context:{
        source:{instanceId:'dc-'+'1'.repeat(32),taskId:'dc-'+'2'.repeat(32),sourceSha:releaseInputs().head,applicationVersion:'1.0.0',environment:'test-aaaabbbbcccc',
          configuration:configurations.source,resources:inventory(configurations.source),resultDigest:'f'.repeat(64)},
        resources:inventory(configurations.target),urls:[configurations.target.email.origin,configurations.target.platform.origin]}};
    const originalPreview=structuredClone(request),input=path.join(root,'input.json');
    const ports={sourcePort:bridge.source.port,targetPort:bridge.target.port,commandPort:bridge.port};
    if(repairing){
      await fs.writeFile(input,JSON.stringify({request,release:path.join(target.directory,'prepared'),...ports,failCredentials:true}));
      const failedRun=await promisify(execFile)('python',[path.resolve('.sba/tests/preview-runtime-driver.py'),input,path.join(root,'failed-operation')],
        {encoding:'utf8',windowsHide:true,timeout:180000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
      const failed=JSON.parse(failedRun.stdout);assert.equal(failed.status,'unknown');assert.equal(failed.errorCode,'EASYEMAIL_PREVIEW_CREDENTIAL_FAILED');
      assert.deepEqual(bridge.commands,[]);
      for(const database of [target.db,target.emailDb])assert.deepEqual((await database.prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_METADATA','_cf_KV')").all()).results,[]);
      const copied=await(await target.bucket('OUTBOX')).list();assert.equal(copied.objects.length,1);
      assert.notEqual(copied.objects[0].version,(await(await source.bucket('OUTBOX')).head(copied.objects[0].key)).version);
      request={...request,action:'repair',taskId:'dc-'+'5'.repeat(32),applicationVersion:'1.0.4',
        previous:{sourceSha:originalPreview.sourceSha,applicationVersion:initialVersion},context:{repairId:'complete-preview-credentials',
          parentTaskId:originalPreview.taskId,parentRunId:123,requestDigest:'e'.repeat(64),resultDigest:digest(failed),
          errorCode:failed.errorCode,preview:originalPreview.context}};
    }
    const repairStart=bridge.target.routes.length;
    await fs.writeFile(input,JSON.stringify({request,release:repairing?candidate.directory:path.join(target.directory,'prepared'),...ports}));
    const run=await promisify(execFile)('python',[path.resolve('.sba/tests/preview-runtime-driver.py'),input,path.join(root,'operation')],
      {encoding:'utf8',windowsHide:true,timeout:180000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    const result=JSON.parse(run.stdout);assert.equal(result.status,'succeeded',run.stdout);
    assert.deepEqual(bridge.commands,[...(repairing?['publish-email','publish-platform']:[]),'restore-email','restore-platform','migrate']);
    assert.equal(bridge.source.exports,repairing?8:6);assert.equal(bridge.target.exports,2);
    if(repairing){
      assert.equal(bridge.target.routes.slice(repairStart).filter(row=>row.method==='PUT'&&row.path.startsWith('/__easyemail_sba/v1/')).length,1,
        'repair may persist provenance but must not rewrite existing business objects');
      await verifyStampedRelease(target.candidate,candidate.proofPath,candidate.checksum,candidate.proof.metadata);
    }
    for (const errors of [bridge.errors,bridge.source.errors,bridge.target.errors]) assert.deepEqual(errors,[]);
    const provenance=await (await target.bucket('OUTBOX')).get('_easyemail-sba/previews/'+request.taskId+'.json');
    const record=await provenance.json();assert.equal(record.payload.resultDigest,digest(result));assert.deepEqual(record.payload.result,result);
    if(repairing)assert.equal(record.payload.instanceId,originalPreview.taskId);
    assert.deepEqual(await dump(source.db),platformSql);assert.deepEqual(await dump(source.emailDb),emailSql);
    assert.equal((await target.request('/api/v1/me',{cookie:user.cookie})).status,401);
    const login=await target.request('/api/v1/auth/login',{method:'POST',body:{username:'admin',password:RELEASE_PASSWORD}});assert.equal(login.status,200,login.text);
    const read=await target.dispatch(`/api/v1/outbox-attachments/${attachment}/content`,{headers:{Cookie:login.cookie}});
    assert.equal(read.status,200);assert.deepEqual(Buffer.from(await read.arrayBuffer()),bytes);
    assert.deepEqual(Buffer.from(await (await (await target.bucket('INBOX')).get('preview-standalone-message')).arrayBuffer()),inbox);
    assert.equal((await target.request(`/api/v1/mailboxes/${box.id}/sync`,{method:'POST',cookie:login.cookie,body:{}})).status,200);
    assert.equal((await target.request(`/api/v1/mailboxes/${box.id}/messages`,{cookie:login.cookie})).body.items.length,1);
    await source.checkIntegrity();
    if(repairing){for(const database of [target.db,target.emailDb])assert.deepEqual((await database.prepare('PRAGMA foreign_key_check').all()).results,[]);}
    else await target.checkIntegrity();
    assert.deepEqual(source.external,[]);assert.deepEqual(target.external,[]);
    const objectIdentities=async(binding,fixture)=>(await(await fixture.bucket(binding)).list()).objects.map(row=>
      ({key:row.key,size:row.size,etag:row.etag,version:row.version,uploaded:row.uploaded.toISOString()}));
    const sourceObjects={};for(const binding of ['INBOX','OUTBOX'])sourceObjects[binding]=await objectIdentities(binding,source);
    cleanupBridge=await cleanupRuntimeBridge(target,configurations.target);
    const cleanupRequest={...request,taskId:'dc-'+'4'.repeat(32),action:'destroy-preview',
      previous:{sourceSha:request.sourceSha,applicationVersion:request.applicationVersion},context:{instanceId:originalPreview.taskId,
      previewTaskId:request.taskId,resultDigest:digest(result),resources:originalPreview.context.resources}};
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
      attachmentReadable:true,independentRepair:repairing,realMailSent:false,result,cleanup},null,2)+'\n','utf8');
    console.log('Native preview lifecycle evidence: '+root);
  } finally {try {await cleanupBridge?.close();} finally {try {await bridge?.close();} finally {try {await target?.close();} finally {await source?.close();}}}}
});
