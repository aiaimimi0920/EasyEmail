import { Button, ConfirmDialog, Field, Notice, Select } from '@neuro/ui';
import { useEffect, useState } from "react";
import { safeUnsubscribeUrl } from "../src/subscription-methods";

export function SubscriptionMethods({ methods }: { methods: string[] }) {
  const safe = [...new Set(methods.map(safeUnsubscribeUrl).filter((url): url is string => url !== null))].slice(0, 8);
  const [selected, setSelected] = useState(""), [notice, setNotice] = useState("");
  const url = safe.includes(selected) ? selected : safe[0];
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => { setOpening(null); }, [url]);
  function open() {
    const checked = url && safeUnsubscribeUrl(url);
    if (checked) setOpening(checked);
  }
  async function copy() {
    const checked = url && safeUnsubscribeUrl(url); if (!checked) return;
    try { await navigator.clipboard.writeText(checked); setNotice("已复制退订地址，尚未退订"); }
    catch { setNotice("复制失败，请手动复制所选地址"); }
  }
  return <section aria-label="退订方法"><h4>退订方法</h4>
    {url ? <><Field label="退订地址"><Select aria-label="退订地址" value={url} onChange={event => { setSelected(event.target.value); setNotice(""); }}>
      {safe.map(value => <option key={value} value={value}>{value}</option>)}
    </Select></Field><div className="row"><Button type="button" onClick={open} variant="quiet" wrap>打开退订地址</Button>
      <Button type="button" onClick={copy} variant="quiet" wrap>复制退订地址</Button></div></> : <p>没有可安全打开的退订地址</p>}
    {notice && <Notice role="status" tone="info">{notice}</Notice>}
    <ConfirmDialog title="打开退订地址" open={!!opening && opening === url}
      description={`将离开 EasyEmail，打开邮件提供的退订地址：\n${opening ?? ''}\n可能向对方暴露访问信息；EasyEmail 不验证退订结果。是否继续？`}
      onOpenChange={open => { if (!open) setOpening(null); }} onConfirm={() => {
        const checked = opening && opening === url && safeUnsubscribeUrl(opening);
        if (checked) {
          window.open(checked, "_blank", "noopener,noreferrer"); setNotice("已请求打开地址，退订结果未验证");
        }
        setOpening(null);
      }} />
  </section>;
}
