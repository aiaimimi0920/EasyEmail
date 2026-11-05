import { Button } from '@neuro/ui';
import { useEffect, useRef, type ReactNode } from 'react';

export function MessageWorkspace({ selected, onBack, list, children, tools, active = true }: {
  selected: boolean; onBack: () => void; list: ReactNode; children: ReactNode; tools?: ReactNode; active?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const readingRef = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLButtonElement | null>(null);
  const wasSelected = useRef(false), restoreFocus = useRef(false);
  useEffect(() => {
    if (active && selected) {
      if (!wasSelected.current && window.matchMedia('(max-width: 700px)').matches) readingRef.current?.focus();
    } else if (active && restoreFocus.current) {
      previous.current?.focus(); restoreFocus.current = false;
    }
    wasSelected.current = selected;
  }, [active, selected]);
  return <div className="message-workspace" data-open={selected} data-tools={!!tools}>
    <div ref={listRef} className="message-list-pane" data-testid="message-list-pane">{list}</div>
    <div ref={readingRef} className="message-reading-pane" data-testid="message-reading-pane" tabIndex={-1}>
      <div className="reader-content">
        {selected ? <><Button className="reader-back" onClick={() => {
          previous.current = listRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ?? null;
          restoreFocus.current = true; onBack();
        }} variant="quiet" wrap>返回邮件列表</Button>{children}</>
          : <div className="reader-empty"><span aria-hidden="true">↗</span><h3>选择一封邮件</h3><p>在列表中打开邮件</p></div>}
      </div>
      {tools}
    </div>
  </div>;
}
