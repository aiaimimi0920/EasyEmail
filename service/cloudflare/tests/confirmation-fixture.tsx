import { Button, NeuroProvider } from '@neuro/ui';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmationProvider, useConfirmation } from '../web/Confirmation';
import { Composer } from '../web/Composer';
import type { ComposeRequest } from '../web/api';

const results: string[] = [];
declare global {
  interface Window {
    confirmationFixture: {
      change: () => void;
      unmount: () => void;
      request: (nonce: string) => void;
      mode: (value: string) => void;
      same: () => void;
      results: string[];
    };
  }
}

function Owner({ name, identity, same }: { name: string; identity: number; same: boolean }) {
  const confirm = useConfirmation([identity]);
  return <Button onClick={async () => { results.push(`${name}:${await confirm(same ? '相同风险' : name)}`); }}>{name}</Button>;
}

function Fixture() {
  const [identity, setIdentity] = useState(0), [mounted, setMounted] = useState(true);
  const [mode, setMode] = useState('queue'), [request, setRequest] = useState<ComposeRequest | null>(null);
  const [same, setSame] = useState(false);
  window.confirmationFixture = {
    change: () => setIdentity(old => old + 1), unmount: () => setMounted(false), mode: setMode, same: () => setSame(true),
    request: nonce => setRequest({ nonce, mailboxId: 'mailbox', message: {
      id: nonce, subject: nonce, replyAddress: `${nonce.toLowerCase()}@example.test`,
    } } as ComposeRequest), results,
  };
  if (mode === 'empty') return <p>确认宿主已卸载</p>;
  return <ConfirmationProvider>
    {mode === 'composer' ? <Composer visible request={request} /> : <>
      {mounted && <Owner name="请求 A" identity={identity} same={same} />}
      <Owner name="请求 B" identity={0} same={same} />
    </>}
  </ConfirmationProvider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><NeuroProvider><Fixture /></NeuroProvider></StrictMode>);
