import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewRuntime, rewritePreview } from '../preview-vault.mjs';

const sourceEnv={MAILBOX_KEYRING:JSON.stringify({active:'sba1',keys:{sba1:'a3'.repeat(32)}})};
const targetEnv={MAILBOX_KEYRING:JSON.stringify({active:'preview1',keys:{sba1:'a3'.repeat(32),preview1:'b4'.repeat(32)}})};
const sourceJwt='synthetic-source-signing-key-32-bytes',targetJwt='synthetic-target-signing-key-32-bytes';
const context={id:'mailbox',user_id:'user',provider_id:'self',remote_id:'23',address:'old@example.com'};
const configuration={sourceEmail:'https://email-api.example.com',sourcePlatform:'https://mail.example.com',
  targetEmail:'https://test-123456abcdef-email.synthetic.workers.dev',targetPlatform:'https://test-123456abcdef-platform.synthetic.workers.dev',mailDomain:'copy.test'};

async function input() {
  const runtime=await previewRuntime();
  const token=await runtime.sign({address:context.address,address_id:23,exp:1},sourceJwt,'HS256');
  const credential_cipher=await runtime.encryptCredential(sourceEnv,context,{token});
  return {configuration,sourceEnv,targetEnv,sourceJwt,targetJwt,mailboxes:[{...context,credential_cipher}],
    providers:[{id:'self',config_json:JSON.stringify({id:'self',type:'cloudflare',baseUrl:configuration.sourceEmail,domains:['example.com'],enabled:true,sendTransport:'binding',sendRecipients:['allowed@example.com']})},
      {id:'remote',config_json:JSON.stringify({id:'remote',type:'temporam',baseUrl:'https://external.example.com',domains:[],enabled:true})}]};
}

test('real vault and Hono JWT keep mailbox identity/expiry but replace source signing authority with copy authority',async()=>{
  const runtime=await previewRuntime(),value=await input(),before=structuredClone(value),result=await rewritePreview(value);
  const opened=await runtime.decryptCredential(targetEnv,context,result.mailboxes[0].cipher);
  const claims=await runtime.verify(opened.token,targetJwt,{alg:'HS256',exp:false});
  assert.equal(claims.address,context.address);assert.equal(claims.address_id,23);assert.equal(claims.exp,1);
  await assert.rejects(runtime.verify(opened.token,sourceJwt,{alg:'HS256',exp:false}));
  await assert.rejects(runtime.decryptCredential(sourceEnv,context,result.mailboxes[0].cipher));
  const externalContext={id:'external-account',user_id:'user',provider_id:'external'};
  const external=await runtime.encryptCredential(sourceEnv,externalContext,{token:'synthetic-legacy-password'});
  assert.equal((await runtime.decryptCredential(targetEnv,externalContext,external)).token,'synthetic-legacy-password');
  assert.deepEqual(value,before);
});

test('provider copies point only to clone-local endpoints and cannot retain send policies or enabled external providers',async()=>{
  const result=await rewritePreview(await input()),self=JSON.parse(result.providers[0].config_json),remote=JSON.parse(result.providers[1].config_json);
  assert.equal(self.baseUrl,configuration.targetEmail);assert.deepEqual(self.domains,['copy.test']);assert.equal(self.sendTransport,undefined);assert.deepEqual(self.sendRecipients,[]);
  assert.equal(remote.enabled,false);assert.equal(new URL(remote.baseUrl).origin,configuration.targetEmail);
  assert.doesNotMatch(JSON.stringify(result),/external\.example\.com|allowed@example\.com/);
});

test('wrong signature, context, address or source provider identity never yield rewritten credentials',async()=>{
  for(const mutate of [value=>value.sourceJwt=targetJwt,value=>value.mailboxes[0].id='other',value=>value.mailboxes[0].address='other@example.com',
    value=>value.mailboxes[0].remote_id='24',value=>value.providers[0].config_json=value.providers[1].config_json]) {
    const value=await input();mutate(value);await assert.rejects(rewritePreview(value));
  }
});
