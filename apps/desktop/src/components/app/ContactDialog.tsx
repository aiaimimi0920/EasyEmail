import type { AppController } from "../../app/useAppController";

export function ContactDialog({ controller }: { controller: AppController }) {
  const {
    closeContactModal, contactDraftFirstName, setContactDraftFirstName, contactDraftLastName, setContactDraftLastName, contactDraftDisplayName, contactDraftEmail, setContactDraftDisplayName,
    setContactDraftEmail, contactDraftPhone, setContactDraftPhone, contactDraftAddress, setContactDraftAddress, contactDraftBirthday, setContactDraftBirthday, contactDraftOrganization,
    setContactDraftOrganization, contactDraftTitle, setContactDraftTitle, contactDraftNote, setContactDraftNote, createContactFromDraft, busy,
  } = controller;
  return (
    <section
      className="nt-contact-modal"
      role="dialog"
      aria-modal="true"
      aria-label="添加联系人"
      data-modal-id="contact"
      tabIndex={-1}
    >
      <header className="nt-contact-modal__header">
        <strong>创建联系人</strong>
        <button type="button" aria-label="关闭添加联系人" onClick={closeContactModal}>
          ×
        </button>
      </header>
      <div className="nt-contact-modal__form">
        <section className="nt-contact-modal__section nt-contact-modal__identity">
          <label>
            <span>姓名</span>
            <div className="nt-contact-modal__split">
              <input
                data-modal-initial-focus
                value={contactDraftFirstName}
                placeholder="名"
                aria-label="名"
                onChange={(event) => setContactDraftFirstName(event.currentTarget.value)}
              />
              <input
                value={contactDraftLastName}
                placeholder="姓"
                aria-label="姓"
                onChange={(event) => setContactDraftLastName(event.currentTarget.value)}
              />
            </div>
          </label>
          <label>
            <span>显示名称</span>
            <input
              value={contactDraftDisplayName}
              placeholder={contactDraftEmail || "写信时显示的名称"}
              onChange={(event) => setContactDraftDisplayName(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>邮箱地址</span>
            <div className="nt-contact-modal__email-row">
            <select aria-label="主要邮箱类型" defaultValue="email">
              <option value="email">邮箱</option>
              <option value="work">工作</option>
              <option value="home">家庭</option>
            </select>
            <input
              value={contactDraftEmail}
              placeholder="friend@example.com"
              aria-label="邮箱地址"
              onChange={(event) => setContactDraftEmail(event.currentTarget.value)}
            />
          </div>
          </label>
        </section>

        <section className="nt-contact-modal__section">
          <h3>电话号码</h3>
          <input
            value={contactDraftPhone}
            placeholder="添加电话号码"
            aria-label="电话号码"
            onChange={(event) => setContactDraftPhone(event.currentTarget.value)}
          />
        </section>

        <section className="nt-contact-modal__section">
          <h3>地址</h3>
          <input
            value={contactDraftAddress}
            placeholder="添加地址"
            aria-label="地址"
            onChange={(event) => setContactDraftAddress(event.currentTarget.value)}
          />
        </section>

        <section className="nt-contact-modal__section nt-contact-modal__two-column">
          <label>
            <span>生日</span>
            <input
              value={contactDraftBirthday}
              placeholder="YYYY-MM-DD"
              onChange={(event) => setContactDraftBirthday(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>其他信息</span>
            <input
              value={contactDraftOrganization}
              placeholder="组织"
              onChange={(event) => setContactDraftOrganization(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>职务</span>
            <input
              value={contactDraftTitle}
              placeholder="角色或职务"
              onChange={(event) => setContactDraftTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>备注</span>
            <textarea
              value={contactDraftNote}
              placeholder="添加备注"
              onChange={(event) => setContactDraftNote(event.currentTarget.value)}
            />
          </label>
        </section>

        <div className="nt-contact-modal__actions">
          <button type="button" onClick={closeContactModal}>
            取消
          </button>
          <button
            type="button"
            className="nt-contact-modal__primary"
            onClick={() => void createContactFromDraft()}
            disabled={busy}
          >
            保存联系人
          </button>
        </div>
      </div>
    </section>
  );
}
