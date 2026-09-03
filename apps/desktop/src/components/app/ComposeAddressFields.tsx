import type { AppController } from "../../app/useAppController";

export function ComposeAddressFields({ controller }: { controller: AppController }) {
  const {
    selectedNormalAccountId, setSelectedNormalAccountId, sendEnabledAccounts, renderComposeRecipientEditor, composeCcOpen, setComposeCcOpen, composeBccOpen, setComposeBccOpen,
    renderComposeContactPicker, sendSubject, setSendSubject,
  } = controller;
  return (
    <div className="nt-compose-popover__fields">
      <label className="nt-compose-popover__row">
        <span>发件人</span>
        <select
          value={selectedNormalAccountId ?? ""}
          onChange={(event) => setSelectedNormalAccountId(event.currentTarget.value || null)}
        >
          <option value="">选择可发送账户</option>
          {sendEnabledAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.display_name} - {account.primary_address ?? account.id}
            </option>
          ))}
        </select>
      </label>
      <div className="nt-compose-popover__row">
        <span>收件人</span>
        {renderComposeRecipientEditor("to", "target@example.com")}
        <button
          type="button"
          aria-expanded={composeCcOpen}
          aria-controls="compose-cc-recipients"
          onClick={() => setComposeCcOpen((value) => !value)}
        >
          CC
        </button>
        <button
          type="button"
          aria-expanded={composeBccOpen}
          aria-controls="compose-bcc-recipients"
          onClick={() => setComposeBccOpen((value) => !value)}
        >
          BCC
        </button>
      </div>
      {renderComposeContactPicker("to")}
      {composeCcOpen ? (
        <div id="compose-cc-recipients" className="nt-compose-popover__row">
          <span>CC</span>
          {renderComposeRecipientEditor("cc", "cc@example.com")}
        </div>
      ) : null}
      {composeCcOpen ? renderComposeContactPicker("cc") : null}
      {composeBccOpen ? (
        <div id="compose-bcc-recipients" className="nt-compose-popover__row">
          <span>BCC</span>
          {renderComposeRecipientEditor("bcc", "bcc@example.com")}
        </div>
      ) : null}
      {composeBccOpen ? renderComposeContactPicker("bcc") : null}
      <label className="nt-compose-popover__row">
        <span>主题</span>
        <input
          value={sendSubject}
          placeholder="主题"
          onChange={(event) => setSendSubject(event.currentTarget.value)}
        />
      </label>
    </div>
  );
}
