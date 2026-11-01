import { useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from './api';
import { readRecovery, type RecoveryReceipt } from './mailbox-access-recovery';

export function MailboxRecoveryLookup({ disabled, onRecovered }: {
  disabled: boolean; onRecovered: (receipt: RecoveryReceipt) => Promise<void>;
}) {
  const [key, setKey] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const busy = useRef(false);
  async function lookup(event: FormEvent) {
    event.preventDefault(); if (disabled || busy.current || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) return;
    busy.current = true; setPending(true); setError(''); setNotice('');
    try {
      const receipt = readRecovery(await api(`/mailbox-access-recoveries/${key}`), key);
      setNotice(`已核对原恢复回执：${receipt.address}；当前邮箱状态另行读取`);
      await onRecovered(receipt);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  return <form className="row" onSubmit={lookup}>
    <label>已有恢复请求键<input value={key} maxLength={128} pattern="[a-zA-Z0-9_-]{16,128}" required disabled={disabled || pending}
      autoComplete="off" onChange={event => setKey(event.target.value)} /></label>
    <button disabled={disabled || pending || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)}>只读核对已有恢复</button>
    {notice && <p role="status" className="creation-status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </form>;
}
