import { useState } from "react";
import { safeUnsubscribeUrl } from "../src/subscription-methods";

export function SubscriptionMethods({ methods }: { methods: string[] }) {
  const safe = [...new Set(methods.map(safeUnsubscribeUrl).filter((url): url is string => url !== null))].slice(0, 8);
  const [selected, setSelected] = useState(""), [notice, setNotice] = useState("");
  const url = safe.includes(selected) ? selected : safe[0];
  function open() {
    const checked = url && safeUnsubscribeUrl(url);
    if (checked && window.confirm(`将离开 EasyEmail，打开邮件提供的退订地址：\n${checked}\n可能向对方暴露访问信息；EasyEmail 不验证退订结果。是否继续？`)) {
      window.open(checked, "_blank", "noopener,noreferrer"); setNotice("已请求打开地址，退订结果未验证");
    }
  }
  async function copy() {
    const checked = url && safeUnsubscribeUrl(url); if (!checked) return;
    try { await navigator.clipboard.writeText(checked); setNotice("已复制退订地址，尚未退订"); }
    catch { setNotice("复制失败，请手动复制所选地址"); }
  }
  return <section aria-label="退订方法"><h4>退订方法</h4>
    {url ? <><label>退订地址<select aria-label="退订地址" value={url} onChange={event => { setSelected(event.target.value); setNotice(""); }}>
      {safe.map(value => <option key={value} value={value}>{value}</option>)}
    </select></label><div className="row"><button type="button" className="secondary" onClick={open}>打开退订地址</button>
      <button type="button" className="secondary" onClick={copy}>复制退订地址</button></div></> : <p>没有可安全打开的退订地址</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
