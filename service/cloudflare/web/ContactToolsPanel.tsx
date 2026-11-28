import { Button, Disclosure, Notice } from '@neuro/ui';
import { useState, type ChangeEvent } from "react";
import type { ContactDuplicateGroup } from "../../base/src/domain/mail-contact-tools";
import { api, errorMessage } from "./api";
import { useConfirmation } from "./Confirmation";

export function ContactToolsPanel({ onChanged }: { onChanged: () => void }) {
  const [groups, setGroups] = useState<ContactDuplicateGroup[] | null>(null);
  const [candidates, setCandidates] = useState<Array<{ displayName: string; emailAddress: string }> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const confirm = useConfirmation([groups?.length, candidates?.length]);

  async function scanDuplicates() {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const res = await api<{ groups: ContactDuplicateGroup[] }>("/contact-tools/duplicates");
      setGroups(res.groups);
      if (res.groups.length === 0) setNotice("未检测到重复联系人或 +alias 别名组");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function mergeGroup(group: ContactDuplicateGroup) {
    const primary = group.members[0];
    if (!primary || group.members.length < 2) return;
    const secondaryIds = group.members.slice(1).map((m) => m.id);
    if (
      !(await confirm(
        `确认将 ${group.members.length} 位重复联系人无损合并至主记录「${primary.displayName} (${primary.emailAddress})」？次要邮箱将保留为别名。`,
      ))
    ) {
      return;
    }
    setPending(true);
    setError("");
    try {
      await api("/contact-tools/merge", "POST", {
        primaryContactId: primary.id,
        secondaryContactIds: secondaryIds,
      });
      setNotice(`已无损合并至 ${primary.emailAddress}`);
      await scanDuplicates();
      onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function exportVCard() {
    setPending(true);
    setError("");
    try {
      const res = await api<{ vcf: string; count: number }>("/contact-tools/vcard");
      const blob = new Blob([res.vcf], { type: "text/vcard;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "easyemail-contacts.vcf";
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`已导出 ${res.count} 位联系人为 RFC 6350 vCard (.vcf)`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function importVCard(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPending(true);
    setError("");
    try {
      const vcf = await file.text();
      const res = await api<{ importedCount: number }>("/contact-tools/vcard", "POST", { vcf });
      setNotice(`已从 vCard 导入／更新 ${res.importedCount} 位联系人`);
      onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  async function scanSenderCandidates() {
    setPending(true);
    setError("");
    try {
      const res = await api<{ candidates: Array<{ displayName: string; emailAddress: string }> }>(
        "/contact-tools/candidates",
      );
      setCandidates(res.candidates);
      if (res.candidates.length === 0) setNotice("近期来信中暂无新的可提取人类联系人");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <Disclosure title="联系人去重合并、近期发件人提取与 vCard 导入／导出">
      {error && <Notice role="alert" tone="danger">{error}</Notice>}
      {notice && <Notice role="status" tone="info">{notice}</Notice>}
      <div className="row">
        <Button type="button" variant="quiet" disabled={pending} onClick={() => void scanDuplicates()} wrap>
          检测重复与 +alias 联系人
        </Button>
        <Button type="button" variant="quiet" disabled={pending} onClick={() => void scanSenderCandidates()} wrap>
          从近期收件提取候选联系人
        </Button>
        <Button type="button" variant="quiet" disabled={pending} onClick={() => void exportVCard()} wrap>
          导出 vCard (.vcf)
        </Button>
        <label className="row">
          <span>导入 vCard (.vcf)：</span>
          <input type="file" accept=".vcf,text/vcard" disabled={pending} onChange={(e) => void importVCard(e)} />
        </label>
      </div>

      {groups && groups.length > 0 && (
        <ul>
          {groups.map((g) => (
            <li key={g.groupKey}>
              <strong>
                {g.reason === "canonical_plus_alias" ? "+alias 同源邮箱" : "同名联系人"}：{g.canonicalKey}
              </strong>{" "}
              <small>（{g.members.map((m) => m.emailAddress).join(" / ")}）</small>{" "}
              <Button type="button" variant="quiet" disabled={pending} onClick={() => void mergeGroup(g)} wrap>
                单事务无损合并
              </Button>
            </li>
          ))}
        </ul>
      )}

      {candidates && candidates.length > 0 && (
        <ul>
          {candidates.slice(0, 12).map((c) => (
            <li key={c.emailAddress}>
              <span>
                {c.displayName} ({c.emailAddress})
              </span>{" "}
              <Button
                type="button"
                variant="quiet"
                disabled={pending}
                onClick={async () => {
                  await api(
                    "/contacts",
                    "POST",
                    { displayName: c.displayName, emailAddress: c.emailAddress, note: "" },
                    { "idempotency-key": crypto.randomUUID() },
                  );
                  setCandidates((prev) => prev?.filter((item) => item.emailAddress !== c.emailAddress) ?? null);
                  onChanged();
                }}
                wrap
              >
                加入通讯录
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Disclosure>
  );
}
