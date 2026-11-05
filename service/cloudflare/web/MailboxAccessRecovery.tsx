import { Button, Field, Input, Notice, Select } from '@neuro/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from './api';
import { useMailboxAccessRecovery } from './useMailboxAccessRecovery';
import type { RecoveryReceipt } from './mailbox-access-recovery';
import { MailboxRecoveryLookup } from './MailboxRecoveryLookup';

interface Provider { id: string; capabilities: { credentialRecovery?: false | 'proof-required-v1' } }
export function MailboxAccessRecovery({ visible, onRecovered }: {
  visible: boolean; onRecovered: (receipt: RecoveryReceipt) => Promise<void>;
}) {
  const [providers, setProviders] = useState<Provider[]>([]), [providerId, setProviderId] = useState('');
  const [address, setAddress] = useState(''), [token, setToken] = useState(''), [catalogError, setCatalogError] = useState('');
  const recovery = useMailboxAccessRecovery(onRecovered), locked = !!recovery.operation || recovery.pending;
  useEffect(() => {
    if (!visible) return;
    let active = true;
    api<{ items: Provider[] }>('/providers').then(value => {
      if (!active) return;
      const rows = value.items.filter(row => row.capabilities.credentialRecovery === 'proof-required-v1');
      setProviders(rows); setProviderId(old => rows.some(row => row.id === old) ? old : rows[0]?.id ?? ''); setCatalogError('');
    }).catch(failure => { if (active) setCatalogError(errorMessage(failure)); });
    return () => { active = false; };
  }, [visible]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || !providerId || !address || !token) return;
    recovery.submit({ providerId, address: address.trim().toLowerCase(), token }); setToken('');
  }
  return <section aria-label="恢复已有临时邮箱">
    <h3>恢复已有临时邮箱</h3>
    <form className="row" onSubmit={submit} autoComplete="off">
      <Field label="恢复供应商"><Select value={providerId} disabled={locked || providers.length === 0} onChange={event => setProviderId(event.target.value)}>
        {providers.map(row => <option key={row.id}>{row.id}</option>)}
      </Select></Field>
      <Field label="已有邮箱地址"><Input type="email" value={address} maxLength={254} required disabled={locked} onChange={event => setAddress(event.target.value)} /></Field>
      <Field label="邮箱访问凭据"><Input type="password" value={token} maxLength={4096} required disabled={locked} autoComplete="off" spellCheck={false} onChange={event => setToken(event.target.value)} /></Field>
      <Button disabled={locked || !providerId || !address.trim() || !token} type="submit" wrap>验证并恢复访问</Button>
    </form>
    {!providers.length && !catalogError && <Notice role="status" tone="info">暂无支持凭据恢复的供应商</Notice>}
    {recovery.operation && <div>
      <Notice role="status" className="creation-status" tone="info">原恢复请求：<code>{recovery.operation.key}</code> · {recovery.operation.input.address}</Notice>
      <Button disabled={recovery.pending} onClick={recovery.check} wrap>核对原恢复结果</Button>
      {recovery.missing && <>
        <Button disabled={recovery.pending} onClick={recovery.retry} wrap>重试原恢复请求</Button>
        <Button disabled={recovery.pending} onClick={recovery.discardMissing} variant="quiet" wrap>结束本次恢复验证</Button>
      </>}
    </div>}
    {recovery.notice && <Notice role="status" className="creation-status" tone="info">{recovery.notice}</Notice>}
    {(catalogError || recovery.error) && <Notice role="alert" tone="danger">{catalogError || recovery.error}</Notice>}
    <MailboxRecoveryLookup disabled={locked} onRecovered={onRecovered} />
  </section>;
}
