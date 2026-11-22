import { ConfirmDialog } from '@neuro/ui';
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface Request {
  id: number;
  owner: symbol;
  description: string;
  origin: HTMLElement | null;
  resolve: (accepted: boolean) => void;
}
interface Confirmations {
  request(owner: symbol, description: string): Promise<boolean>;
  cancel(owner: symbol): void;
}
const Context = createContext<Confirmations | null>(null);

// Promise ownership and ordering belong to EasyEmail; the library owns the modal.
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const queue = useRef<Request[]>([]), sequence = useRef(0), alive = useRef(false);
  const origin = useRef<HTMLElement | null>(null);
  const clickedRequest = useRef<number | null>(null);
  const [current, setCurrent] = useState<Request | null>(null);
  const [controller] = useState<Confirmations>(() => ({
    request(owner, description) {
      if (!alive.current || queue.current.some(item => item.owner === owner)) return Promise.resolve(false);
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && !focused.closest('[role="alertdialog"]')) origin.current = focused;
      return new Promise(resolve => {
        const item = { id: ++sequence.current, owner, description, origin: origin.current, resolve };
        queue.current.push(item);
        if (queue.current.length === 1) setCurrent(item);
      });
    },
    cancel(owner) {
      const removed = queue.current.filter(item => item.owner === owner);
      queue.current = queue.current.filter(item => item.owner !== owner);
      if (alive.current && removed.length) setCurrent(queue.current[0] ?? null);
      for (const item of removed) item.resolve(false);
    },
  }));
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const item of queue.current.splice(0)) item.resolve(false);
    };
  }, []);
  function finish(accepted: boolean) {
    if (!current || queue.current[0] !== current) return;
    queue.current.shift(); setCurrent(queue.current[0] ?? null); current.resolve(accepted);
  }
  return <Context.Provider value={controller}>{children}
    <div onMouseDownCapture={event => {
      // Keep the next request's library-selected initial focus during that gesture.
      if (event.detail > 1 && clickedRequest.current !== current?.id) event.preventDefault();
    }} onClickCapture={event => {
      // One double-click must not authorize two different queued business intents.
      if (event.detail > 1 && clickedRequest.current !== current?.id) {
        event.preventDefault(); event.stopPropagation();
      } else clickedRequest.current = current?.id ?? null;
    }}><ConfirmDialog title="确认操作" description={current?.description ?? ''} open={!!current}
      focusResetKey={current?.id} returnFocusRef={{ current: current?.origin ?? origin.current }}
      onOpenChange={open => { if (!open) finish(false); }} onConfirm={() => finish(true)}>
      <span hidden data-confirmation-request={current?.id} />
    </ConfirmDialog></div>
  </Context.Provider>;
}

const sameScope = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

// Callers declare the business identity/draft which the displayed risk describes.
// Changing it, unmounting, or a duplicate request rejects the old confirmation.
export function useConfirmation(scope: readonly unknown[]) {
  const controller = useContext(Context);
  if (!controller) throw new Error('ConfirmationProvider is required');
  const owner = useRef(Symbol('confirmation'));
  const lifetime = useRef({ active: false, scope, generation: 0 });
  useLayoutEffect(() => {
    if (!sameScope(scope, lifetime.current.scope)) {
      lifetime.current.generation++;
      controller.cancel(owner.current);
    }
    lifetime.current.scope = scope;
  });
  useLayoutEffect(() => {
    lifetime.current.active = true;
    return () => {
      lifetime.current.active = false;
      lifetime.current.generation++;
      controller.cancel(owner.current);
    };
  }, [controller]);
  return async (description: string): Promise<boolean> => {
    const held = lifetime.current.generation;
    if (!lifetime.current.active || !sameScope(scope, lifetime.current.scope)) return false;
    const accepted = await controller.request(owner.current, description);
    return accepted && lifetime.current.active && held === lifetime.current.generation;
  };
}
