import { useRef, useState } from 'react';
import { api, ApiError, errorMessage } from './api';
import { readRecovery, type RecoveryInput, type RecoveryReceipt } from './mailbox-access-recovery';

interface Operation { key: string; input: RecoveryInput }
export function useMailboxAccessRecovery(onRecovered: (receipt: RecoveryReceipt) => Promise<void>) {
  const [operation, setOperation] = useState<Operation | null>(null), [pending, setPending] = useState(false);
  const [missing, setMissing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const busy = useRef(false);

  async function run(current: Operation, check: boolean) {
    if (busy.current) return;
    busy.current = true; setPending(true); setMissing(false); setError(''); setNotice('');
    let receipt: RecoveryReceipt | null = null;
    try {
      const value = check ? await api(`/mailbox-access-recoveries/${current.key}`)
        : await api('/mailbox-access-recoveries', 'POST', current.input, { 'idempotency-key': current.key });
      receipt = readRecovery(value, current.key, current.input);
      setOperation(null);
      setNotice(`${receipt.mode === 'imported' ? '已导入邮箱访问' : '访问凭据已恢复；原期限与停用状态保留'} · 请求键：${receipt.requestKey}`);
    } catch (failure) {
      if (check && failure instanceof ApiError && failure.status === 404 && failure.message === 'mailbox_recovery_not_found') {
        setMissing(true); setError('未找到持久回执；可使用原键和原凭据重试只读验证，不会创建上游邮箱');
      } else if (!check && failure instanceof ApiError && [400, 401, 403, 409, 413, 415, 429].includes(failure.status)) {
        setOperation(null); setError(errorMessage(failure));
      } else {
        setError(failure instanceof Error && failure.message === 'mailbox_recovery_response_invalid'
          ? '恢复回执不匹配，请使用原请求键只读核对' : `${errorMessage(failure)}；请使用原请求键核对`);
      }
    }
    // Refreshing the mailbox is separate from committing its credential; never turn a refresh error into a new write.
    if (receipt) try { await onRecovered(receipt); }
    catch { setError('访问回执已保存，但邮箱列表刷新失败，请手动刷新邮箱'); }
    busy.current = false; setPending(false);
  }
  function submit(input: RecoveryInput) {
    if (busy.current || operation) return;
    const current = { key: crypto.randomUUID(), input };
    setOperation(current); void run(current, false);
  }
  return { operation, pending, missing, error, notice, submit,
    check: () => { if (operation) void run(operation, true); },
    retry: () => { if (operation && missing) void run(operation, false); },
    discardMissing: () => { if (missing && !busy.current) { setOperation(null); setMissing(false); setError(''); } } };
}
