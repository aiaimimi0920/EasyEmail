import type { CSSProperties } from "react";
import type { AppController } from "../../app/useAppController";

export function MailTaxonomyDialog({ controller }: { controller: AppController }) {
  const {
    mailTaxonomyKindLabel, mailTaxonomyManagerKind, submitMailTaxonomyManager, closeMailTaxonomyManager, mailTaxonomyDraftName, setMailTaxonomyDraftName, mailTaxonomyDraftParentId, setMailTaxonomyDraftParentId,
    mailTaxonomyParentOptions, mailTaxonomyDraftColor, setMailTaxonomyDraftColor, resetMailTaxonomyDraft, busy, mailTaxonomyEditingId, mailTaxonomyItemsForKind, mailFolderTreeItems,
    selectMailTaxonomyItem, editMailTaxonomyItem, deleteMailTaxonomyItem,
  } = controller;
  if (!mailTaxonomyManagerKind) return null;
  return (
    <form
      className="nt-mail-taxonomy-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`${mailTaxonomyKindLabel(mailTaxonomyManagerKind)}管理`}
      data-modal-id="mail-taxonomy"
      tabIndex={-1}
      onSubmit={submitMailTaxonomyManager}
    >
      <header className="nt-mail-taxonomy-modal__header">
        <div>
          <p className="nt-kicker">MAIL ORGANIZATION</p>
          <strong>{mailTaxonomyKindLabel(mailTaxonomyManagerKind)}管理</strong>
        </div>
        <button type="button" aria-label="关闭" onClick={closeMailTaxonomyManager}>
          ×
        </button>
      </header>
      <div className="nt-mail-taxonomy-modal__body">
        <section className="nt-mail-taxonomy-modal__editor">
          <label>
            <span>{mailTaxonomyKindLabel(mailTaxonomyManagerKind)}名称</span>
            <input
              data-modal-initial-focus
              value={mailTaxonomyDraftName}
              maxLength={64}
              placeholder={
                mailTaxonomyManagerKind === "folder" ? "例如：账单、客户、项目" : "例如：重要、待处理、客户"
              }
              onChange={(event) => setMailTaxonomyDraftName(event.currentTarget.value)}
            />
          </label>
          {mailTaxonomyManagerKind === "folder" ? (
            <label>
              <span>父文件夹</span>
              <select
                value={mailTaxonomyDraftParentId}
                onChange={(event) => setMailTaxonomyDraftParentId(event.currentTarget.value)}
              >
                <option value="">无父文件夹</option>
                {mailTaxonomyParentOptions.map(({ item, depth }) => (
                  <option key={item.id} value={item.id}>
                    {"  ".repeat(depth)}
                    {depth > 0 ? "- " : ""}
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>颜色</span>
            <div className="nt-mail-taxonomy-modal__color-row">
              <input
                type="color"
                value={mailTaxonomyDraftColor}
                onChange={(event) => setMailTaxonomyDraftColor(event.currentTarget.value)}
              />
              <span>{mailTaxonomyDraftColor}</span>
            </div>
          </label>
          <div className="nt-mail-taxonomy-modal__actions">
            <button type="button" onClick={() => resetMailTaxonomyDraft(mailTaxonomyManagerKind)}>
              新建
            </button>
            <button type="submit" className="nt-mail-taxonomy-modal__primary" disabled={busy}>
              {mailTaxonomyEditingId ? "保存修改" : `创建${mailTaxonomyKindLabel(mailTaxonomyManagerKind)}`}
            </button>
          </div>
        </section>
        <section className="nt-mail-taxonomy-modal__list" aria-label="已有项目">
          {mailTaxonomyItemsForKind(mailTaxonomyManagerKind).length === 0 ? (
            <p
              className="nt-mail-taxonomy-modal__empty"
              role="status"
              aria-live="polite"
              data-empty-state
            >
              {mailTaxonomyManagerKind === "folder" ? "暂无自定义文件夹。" : "暂无自定义标签。"}
            </p>
          ) : (
            (mailTaxonomyManagerKind === "folder"
              ? mailFolderTreeItems.map(({ item, depth }) => ({ item, depth }))
              : mailTaxonomyItemsForKind(mailTaxonomyManagerKind).map((item) => ({ item, depth: 0 }))
            ).map(({ item, depth }) => (
              <article
                key={item.id}
                className={`nt-mail-taxonomy-modal__item ${
                  mailTaxonomyEditingId === item.id ? "nt-mail-taxonomy-modal__item--editing" : ""
                }`}
                style={{ "--taxonomy-depth": depth } as CSSProperties}
              >
                <span
                  className={
                    item.kind === "folder"
                      ? "nt-mail-taxonomy__folder-icon"
                      : "nt-mail-taxonomy__dot"
                  }
                  style={{ "--taxonomy-color": item.color } as CSSProperties}
                  aria-hidden="true"
                />
                <div>
                  <strong>{item.name}</strong>
                  <small>
                    {item.system ? "系统默认" : "自定义"} · {item.color}
                  </small>
                </div>
                <div className="nt-mail-taxonomy-modal__item-actions">
                  <button type="button" onClick={() => selectMailTaxonomyItem(item)}>
                    查看
                  </button>
                  <button type="button" onClick={() => editMailTaxonomyItem(item)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteMailTaxonomyItem(item)}
                    disabled={item.system}
                    title={item.system ? "系统默认项不能删除" : "删除"}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))
          )}
        </section>
      </div>
      <footer className="nt-mail-taxonomy-modal__footer">
        <span>
          文件夹会移动邮件位置；标签不会改变邮件所在文件夹，且一封邮件可以有多个标签。
        </span>
        <button type="button" onClick={closeMailTaxonomyManager}>
          完成
        </button>
      </footer>
    </form>
  );
}
