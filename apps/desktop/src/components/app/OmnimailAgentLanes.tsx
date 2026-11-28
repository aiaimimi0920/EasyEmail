import { useEffect, useState } from "react";
import { omnimailWorkbenchClient } from "../../app/appRuntime";
import type {
  DesktopMuseStatusDto,
  DesktopWorkBuddyAccountDto,
} from "../../api/omnimailWorkbenchClient";

export function OmnimailAgentLanes({ openUrl }: { openUrl: (url: string) => void }) {
  const [wbAccounts, setWbAccounts] = useState<DesktopWorkBuddyAccountDto[]>([]);
  const [wbSelectedId, setWbSelectedId] = useState("");
  const [wbAuth, setWbAuth] = useState<{ state: string; authUrl: string } | null>(null);
  const [wbMessages, setWbMessages] = useState<Array<{ messageId: string; subject: string; from: string; snippet: string }>>([]);
  const [wbConfirmDelete, setWbConfirmDelete] = useState<{ messageId: string; token: string } | null>(null);

  const [museStatus, setMuseStatus] = useState<DesktopMuseStatusDto | null>(null);
  const [museCookie, setMuseCookie] = useState("");
  const [museThreads, setMuseThreads] = useState<
    Array<{ id: string; subject: string; lastFrom: string; preview: string; messageCount: number }>
  >([]);
  const [museDetail, setMuseDetail] = useState<Array<{ id: string; from: string; bodyText: string }> | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function refreshConnectors() {
    try {
      const [wb, ms] = await Promise.all([
        omnimailWorkbenchClient.listWorkBuddyAccounts(),
        omnimailWorkbenchClient.getMuseStatus(),
      ]);
      setWbAccounts(wb.accounts);
      if (wb.accounts[0] && !wbSelectedId) setWbSelectedId(wb.accounts[0].id);
      setMuseStatus(ms.status);
    } catch {
      // Optional connector endpoints initialize lazily.
    }
  }

  useEffect(() => {
    void refreshConnectors();
  }, []);

  useEffect(() => {
    if (!wbSelectedId) return;
    omnimailWorkbenchClient
      .listWorkBuddyMessages(wbSelectedId, "inbox")
      .then((res) => setWbMessages(res.items))
      .catch(() => {});
  }, [wbSelectedId]);

  const activeWb = wbAccounts.find((a) => a.id === wbSelectedId);

  return (
    <section className="nt-action-board nt-action-board--split" aria-label="专属智能体邮局通道">
      <div>
        <p className="nt-kicker">WORKBUDDY AGENT MAIL</p>
        <div className="nt-row-actions">
          <button
            type="button"
            className="nt-mini-btn nt-mini-btn--signal"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await omnimailWorkbenchClient.startWorkBuddyAuth();
                setWbAuth(res.auth);
                openUrl(res.auth.authUrl);
                setNotice("已在浏览器打开 WorkBuddy 官方授权，完成后点击轮询");
              } catch (err) {
                setNotice(err instanceof Error ? err.message : "发起 WorkBuddy 授权失败");
              } finally {
                setBusy(false);
              }
            }}
          >
            浏览器连接 WorkBuddy
          </button>
          {wbAuth && (
            <button
              type="button"
              className="nt-mini-btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await omnimailWorkbenchClient.pollWorkBuddyAuth(wbAuth.state);
                  if (res.stage === "authorized" && res.account) {
                    setWbAuth(null);
                    setWbSelectedId(res.account.id);
                    await refreshConnectors();
                    setNotice(`已绑定 WorkBuddy：${res.account.emailAddress}`);
                  } else {
                    setNotice("等待浏览器完成授权…");
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              核验授权状态
            </button>
          )}
        </div>
        {activeWb && (
          <small>
            {activeWb.emailAddress} · 今日配额剩余 {activeWb.dailyQuota.remaining}/{activeWb.dailyQuota.limit}
          </small>
        )}
        <div className="nt-scroll-pane nt-scroll-pane--short">
          {wbMessages.map((msg) => (
            <article className="nt-resource-row" key={msg.messageId}>
              <strong>{msg.subject || "（无主题）"}</strong>
              <span>{msg.from}</span>
              <small>{msg.snippet}</small>
              <div className="nt-row-actions">
                <button
                  type="button"
                  className="nt-mini-btn"
                  onClick={async () => {
                    if (!wbSelectedId) return;
                    const step1 = await omnimailWorkbenchClient.deleteWorkBuddyMessage(wbSelectedId, msg.messageId);
                    if (step1.result.needsConfirmation && step1.result.confirmationToken) {
                      setWbConfirmDelete({ messageId: msg.messageId, token: step1.result.confirmationToken });
                    } else {
                      const next = await omnimailWorkbenchClient.listWorkBuddyMessages(wbSelectedId, "inbox");
                      setWbMessages(next.items);
                    }
                  }}
                >
                  删除
                </button>
                {wbConfirmDelete?.messageId === msg.messageId && (
                  <button
                    type="button"
                    className="nt-mini-btn nt-mini-btn--signal"
                    onClick={async () => {
                      if (!wbSelectedId) return;
                      await omnimailWorkbenchClient.deleteWorkBuddyMessage(
                        wbSelectedId,
                        msg.messageId,
                        wbConfirmDelete.token,
                      );
                      setWbConfirmDelete(null);
                      const next = await omnimailWorkbenchClient.listWorkBuddyMessages(wbSelectedId, "inbox");
                      setWbMessages(next.items);
                    }}
                  >
                    确认永久删除
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>

      <div>
        <p className="nt-kicker">META MUSE (@MUSE.AI · 纯内存只读隔离)</p>
        <small>
          遵循零落盘安全准则：Noise_XX_25519_AESGCM_SHA256 端到端加密网关，仅开放只读会话浏览，断开或退出即擦除内存。
        </small>
        {museStatus?.bound ? (
          <div>
            <div className="nt-result">
              <strong>已连接只读实例：{museStatus.verifiedEmail}</strong>
              <span>纯内存态运行中 · 不写入本地 SQLite · 不进入人类发信队列</span>
            </div>
            <div className="nt-row-actions">
              <button
                type="button"
                className="nt-mini-btn"
                disabled={busy}
                onClick={async () => {
                  const res = await omnimailWorkbenchClient.listMuseThreads();
                  setMuseThreads(res.threads ?? []);
                }}
              >
                刷新只读会话
              </button>
              <button
                type="button"
                className="nt-mini-btn"
                disabled={busy}
                onClick={async () => {
                  const res = await omnimailWorkbenchClient.disconnectMuseSession();
                  setMuseStatus(res.status);
                  setMuseThreads([]);
                  setMuseDetail(null);
                  setMuseCookie("");
                  setNotice("已断开 Meta Muse 并擦除全部内存令牌");
                }}
              >
                断开并擦除内存
              </button>
            </div>
            <div className="nt-scroll-pane nt-scroll-pane--short">
              {museThreads.map((t) => (
                <article className="nt-resource-row" key={t.id}>
                  <strong>{t.subject || "（无主题）"}</strong>
                  <span>{t.lastFrom}</span>
                  <small>{t.preview}</small>
                  <button
                    type="button"
                    className="nt-mini-btn"
                    onClick={async () => {
                      const det = await omnimailWorkbenchClient.listMuseThreads(t.id);
                      setMuseDetail(det.detail?.messages ?? []);
                    }}
                  >
                    只读查看 ({t.messageCount})
                  </button>
                </article>
              ))}
            </div>
            {museDetail && (
              <div className="nt-result">
                {museDetail.map((m) => (
                  <div key={m.id}>
                    <strong>{m.from}</strong>
                    <pre style={{ whiteSpace: "pre-wrap" }}>{m.bodyText}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="nt-form-grid nt-form-grid--single">
            <label>
              Meta Muse 临时会话凭证（仅驻留内存）
              <input
                type="password"
                value={museCookie}
                placeholder="粘贴已登录 muse.ai 会话 Cookie 发起只读连接"
                onChange={(e) => setMuseCookie(e.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              className="nt-btn nt-btn--secondary"
              disabled={busy || !museCookie.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await omnimailWorkbenchClient.connectMuseSession(museCookie);
                  setMuseStatus(res.status);
                  setMuseCookie("");
                  const list = await omnimailWorkbenchClient.listMuseThreads();
                  setMuseThreads(list.threads ?? []);
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : "Meta Muse 只读握手失败");
                } finally {
                  setBusy(false);
                }
              }}
            >
              建立纯内存只读连接
            </button>
          </div>
        )}
        {notice && <small>{notice}</small>}
      </div>
    </section>
  );
}
