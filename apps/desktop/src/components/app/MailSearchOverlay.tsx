import type { AppController } from "../../app/useAppController";

export function MailSearchOverlay({ controller }: { controller: AppController }) {
  const {
    closeMailSearchOverlay, mailSearchFullText, setMailSearchFullText, MAIL_SEARCH_PRIMARY_SCOPES, mailSearchScope, selectMailSearchScope, mailSearchOtherMenuOpen, setMailSearchOtherMenuOpen,
    SearchMagnifierIcon, mailSearchFolderFilter, setMailSearchFolderFilter, filteredMailSearchOtherScopes, setMailSearchAdvancedOpen, mailSearchAdvancedOpen, mailSearchStartDate, setMailSearchStartDate,
    mailSearchEndDate, setMailSearchEndDate, mailSearchSender, setMailSearchSender, mailSearchRecipient, setMailSearchRecipient, mailSearchAddress, setMailSearchAddress,
    mailSearchAddressOptions, mailSearchHasAttachment, setMailSearchHasAttachment, mailSearchResultLabel, mailSearchQuery, mailSearchHasAdvancedCriteria, resetMailSearchOptions,
  } = controller;
  return (
    <div
      id="mail-search-overlay"
      className="nt-mail-search-overlay"
      role="dialog"
      aria-label="邮件搜索选项"
      data-nonmodal-layer="mail-search"
      data-nonmodal-preserve-focus
    >
      <div className="nt-mail-search-overlay__header">
        <strong>搜索选项</strong>
        <button
          type="button"
          className="nt-mail-search-overlay__close"
          aria-label="关闭搜索选项"
          title="关闭搜索选项"
          onClick={closeMailSearchOverlay}
        >
          ×
        </button>
      </div>
      <div className="nt-mail-search-overlay__row nt-mail-search-overlay__row--fulltext">
        <span>
          <strong>搜索邮件全文</strong>
          <em>?</em>
        </span>
        <button
          type="button"
          className={`nt-mail-search-toggle ${
            mailSearchFullText ? "nt-mail-search-toggle--active" : ""
          }`}
          role="switch"
          aria-label="搜索邮件全文"
          aria-checked={mailSearchFullText}
          onClick={() => setMailSearchFullText((value) => !value)}
        >
          <span>{mailSearchFullText ? "✓" : ""}</span>
        </button>
      </div>

      <div className="nt-mail-search-group">
        <strong className="nt-mail-search-label">搜索范围</strong>
        <div className="nt-mail-search-scope-row">
          {MAIL_SEARCH_PRIMARY_SCOPES.map((scope) => (
            <button
              type="button"
              key={scope.id}
              className={`nt-mail-search-scope-chip ${
                mailSearchScope === scope.id ? "nt-mail-search-scope-chip--active" : ""
              }`}
              onClick={() => selectMailSearchScope(scope.id)}
            >
              {scope.label}
            </button>
          ))}
          <div className="nt-mail-search-other">
            <button
              type="button"
              className={`nt-mail-search-scope-chip ${
                !MAIL_SEARCH_PRIMARY_SCOPES.some((scope) => scope.id === mailSearchScope)
                  ? "nt-mail-search-scope-chip--active"
                  : ""
              }`}
               data-search-scope="other"
               aria-haspopup="menu"
               aria-expanded={mailSearchOtherMenuOpen}
               aria-controls="mail-search-other-menu"
               data-nonmodal-trigger="mail-search-other"
              onClick={() => setMailSearchOtherMenuOpen((value) => !value)}
            >
              其他 <span>⌄</span>
            </button>
            {mailSearchOtherMenuOpen ? (
              <div
                id="mail-search-other-menu"
                className="nt-mail-search-folder-menu"
                role="menu"
                aria-label="其他搜索范围"
                data-nonmodal-layer="mail-search-other"
              >
                <label className="nt-mail-search-folder-menu__filter">
                  <SearchMagnifierIcon />
                  <input
                    value={mailSearchFolderFilter}
                    placeholder="搜索文件夹"
                    onChange={(event) => setMailSearchFolderFilter(event.currentTarget.value)}
                  />
                </label>
                <strong>系统文件夹</strong>
                {filteredMailSearchOtherScopes.length > 0 ? (
                  filteredMailSearchOtherScopes.map((scope) => (
                    <button
                      type="button"
                      key={scope.id}
                      className={
                        mailSearchScope === scope.id
                          ? "nt-mail-search-folder-menu__item nt-mail-search-folder-menu__item--active"
                          : "nt-mail-search-folder-menu__item"
                      }
                      role="menuitem"
                      onClick={() => selectMailSearchScope(scope.id)}
                    >
                      <span>{scope.icon}</span>
                      {scope.label}
                    </button>
                  ))
                ) : (
                  <p
                    className="nt-mail-search-folder-menu__empty"
                    aria-live="polite"
                    data-empty-state
                  >
                    没有匹配的文件夹
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="nt-mail-search-overlay__divider" />

      <div className="nt-mail-search-overlay__actions">
        <button
          type="button"
          className="nt-mail-search-secondary"
          onClick={() => setMailSearchAdvancedOpen((value) => !value)}
        >
          {mailSearchAdvancedOpen ? "收起搜索选项" : "展开搜索选项"}
        </button>
        <button type="submit" className="nt-mail-search-submit">
          搜索
        </button>
      </div>

      {mailSearchAdvancedOpen ? (
        <div className="nt-mail-search-advanced">
          <div className="nt-mail-search-date-row">
            <label>
              从
              <input
                type="date"
                value={mailSearchStartDate}
                onChange={(event) => setMailSearchStartDate(event.currentTarget.value)}
                aria-label="起始日期"
              />
            </label>
            <label>
              到
              <input
                type="date"
                value={mailSearchEndDate}
                onChange={(event) => setMailSearchEndDate(event.currentTarget.value)}
                aria-label="结束日期"
              />
            </label>
          </div>
          <label>
            发件人
            <input
              value={mailSearchSender}
              placeholder="用户名或邮箱地址"
              onChange={(event) => setMailSearchSender(event.currentTarget.value)}
            />
          </label>
          <label>
            接收者
            <input
              value={mailSearchRecipient}
              placeholder="用户名或邮箱地址"
              onChange={(event) => setMailSearchRecipient(event.currentTarget.value)}
            />
          </label>
          <label>
            地址
            <select
              value={mailSearchAddress}
              onChange={(event) => setMailSearchAddress(event.currentTarget.value)}
            >
              {mailSearchAddressOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="nt-mail-search-filter-row">
            <strong>筛选器</strong>
            <label>
              <input
                type="checkbox"
                checked={mailSearchHasAttachment}
                onChange={(event) => setMailSearchHasAttachment(event.currentTarget.checked)}
              />
              包含附件
            </label>
          </div>
        </div>
      ) : null}

      <div className="nt-mail-search-overlay__footer">
        <span>{mailSearchResultLabel}</span>
        <span className="nt-mail-search-overlay__footer-actions">
          <button
            type="button"
            className="nt-mail-search-cancel"
            onClick={closeMailSearchOverlay}
          >
            取消
          </button>
          {(mailSearchQuery || mailSearchHasAdvancedCriteria || mailSearchScope !== "all-mail") ? (
            <button type="button" onClick={resetMailSearchOptions}>
              重置
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}
