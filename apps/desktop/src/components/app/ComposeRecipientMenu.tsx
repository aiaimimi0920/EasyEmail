import type { AppController } from "../../app/useAppController";

export function ComposeRecipientMenu({ controller }: { controller: AppController }) {
  const {
    composeRecipientMenu, copyComposeRecipient, editComposeRecipient, openContactModal, removeComposeRecipient,
  } = controller;
  if (!composeRecipientMenu) return null;
  return (
    <section
      id="compose-recipient-menu"
      className="nt-compose-recipient-menu"
      style={{
        left: `${composeRecipientMenu.x}px`,
        top: `${composeRecipientMenu.y}px`,
      }}
      role="menu"
      aria-label="收件人操作"
      data-nonmodal-layer="compose-recipient"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => copyComposeRecipient(composeRecipientMenu.address)}
      >
        复制邮箱地址
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => editComposeRecipient(composeRecipientMenu.field, composeRecipientMenu.address)}
      >
        编辑地址
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() =>
          openContactModal(composeRecipientMenu.field, composeRecipientMenu.address)
        }
      >
        创建联系人
      </button>
      <button
        type="button"
        role="menuitem"
        className="nt-compose-recipient-menu__danger"
        onClick={() =>
          removeComposeRecipient(composeRecipientMenu.field, composeRecipientMenu.address)
        }
      >
        移除
      </button>
    </section>
  );
}
