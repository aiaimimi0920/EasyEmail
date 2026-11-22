import type { ReactNode } from "react";

import type { MailTaxonomyKind } from "../../api/mailTaxonomyClient";

type MailTaxonomySectionProps = {
  kind: MailTaxonomyKind;
  expanded: boolean;
  railExpandedReady: boolean;
  drawerOpen: boolean;
  itemCount: number;
  icon: ReactNode;
  renderItems: () => ReactNode;
  onOpenFromIcon: () => void;
  onCreate: () => void;
  onToggle: () => void;
  onSelect: () => void;
};

const sectionMetadata = {
  folder: { label: "文件夹", id: "mail-taxonomy-folders" },
  label: { label: "标签", id: "mail-taxonomy-labels" },
} satisfies Record<MailTaxonomyKind, { label: string; id: string }>;

export function MailTaxonomySection({
  kind,
  expanded,
  railExpandedReady,
  drawerOpen,
  itemCount,
  icon,
  renderItems,
  onOpenFromIcon,
  onCreate,
  onToggle,
  onSelect,
}: MailTaxonomySectionProps) {
  const { label, id } = sectionMetadata[kind];
  const toggleLabel = `${expanded ? "收起" : "展开"}${label}`;

  function renderContent() {
    if (itemCount > 0) {
      return renderItems();
    }
    return (
      <p
        className="nt-mail-taxonomy__empty nt-rail-text"
        role="status"
        aria-live="polite"
        data-empty-state
      >
        无{label}
      </p>
    );
  }

  return (
    <section className="nt-mail-taxonomy__section">
      <div className="nt-mail-taxonomy__head">
        <button
          type="button"
          className="nt-mail-taxonomy__icon-toggle"
          data-modal-return-focus="mail-taxonomy"
          aria-label={toggleLabel}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={onOpenFromIcon}
        >
          <span className="nt-nav__icon nt-mail-taxonomy__icon">{icon}</span>
        </button>
        {railExpandedReady ? (
          <div className="nt-mail-taxonomy__row">
            <button
              type="button"
              className="nt-mail-taxonomy__add"
              aria-label={`新建${label}`}
              onClick={onCreate}
            >
              +
            </button>
            <button
              type="button"
              className="nt-mail-taxonomy__chevron"
              aria-label={toggleLabel}
              aria-expanded={expanded}
              aria-controls={id}
              onClick={onToggle}
            >
              {expanded ? "⌃" : "⌄"}
            </button>
          </div>
        ) : null}
      </div>
      <div id={id} hidden={!expanded}>
        {expanded ? (
          drawerOpen ? (
            <div className="nt-mail-taxonomy__drawer" role="group" aria-label={label}>
              <div className="nt-mail-taxonomy__drawer-head">
                <button
                  type="button"
                  className="nt-mail-taxonomy__drawer-title"
                  onClick={onSelect}
                >
                  <strong>{label}</strong>
                </button>
                <button
                  type="button"
                  className="nt-mail-taxonomy__add"
                  aria-label={`新建${label}`}
                  onClick={onCreate}
                >
                  +
                </button>
                <button
                  type="button"
                  className="nt-mail-taxonomy__chevron"
                  aria-label={`收起${label}`}
                  onClick={onToggle}
                >
                  ⌃
                </button>
              </div>
              {renderContent()}
            </div>
          ) : (
            renderContent()
          )
        ) : null}
      </div>
    </section>
  );
}
