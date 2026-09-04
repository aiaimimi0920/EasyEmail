import type { AppController } from "../../app/useAppController";

import { ComposeActionFooter } from "./ComposeActionFooter";
import { ComposeAddressFields } from "./ComposeAddressFields";
import { ComposeBodyEditor } from "./ComposeBodyEditor";
import { ComposeEncryptionDialog } from "./ComposeEncryptionDialog";
import { ComposeExpirationDialog } from "./ComposeExpirationDialog";
import { ComposeFormatToolbar } from "./ComposeFormatToolbar";
import { ComposeLinkDialog } from "./ComposeLinkDialog";
import { ComposeRecipientMenu } from "./ComposeRecipientMenu";
import { ComposeWindowHeader } from "./ComposeWindowHeader";
import { ContactDialog } from "./ContactDialog";
import { MailTaxonomyDialog } from "./MailTaxonomyDialog";

export function ComposeOverlays({ controller }: { controller: AppController }) {
  const {
    composePopoverOpen,
    composePopoverMinimized,
    composePopoverExpanded,
    composeFormatbarOpen,
    composeAttachments,
    composeEncryptionModalOpen,
    composeAttachmentInputRef,
    composeExpirationModalOpen,
    composeImageInputRef,
    handleComposeImageFile,
    handleComposeAttachmentFiles,
    composeLinkModalOpen,
    mailTaxonomyManagerKind,
    contactModalOpen,
    composeRecipientMenu,
    setComposeRecipientMenu,
  } = controller;

  return (
    <>
      {composePopoverOpen ? (
        <>
          <div className="nt-compose-popover-backdrop" aria-hidden="true" />
          <section
            className={`nt-compose-popover ${
              composePopoverMinimized ? "nt-compose-popover--minimized" : ""
            } ${composePopoverExpanded ? "nt-compose-popover--expanded" : ""}`}
            role="dialog"
            id="compose-popover"
            aria-label="写邮件"
            aria-modal="false"
            data-nonmodal-layer="compose-popover"
            data-nonmodal-preserve-focus
          >
            <ComposeWindowHeader controller={controller} />

            {!composePopoverMinimized ? (
              <>
                <ComposeAddressFields controller={controller} />

                <ComposeBodyEditor controller={controller} />

                {composeFormatbarOpen ? <ComposeFormatToolbar controller={controller} /> : null}

                {composeAttachments.length > 0 ? (
                  <div className="nt-compose-attachments" aria-label="待发送附件">
                    {composeAttachments.map((attachment) => (
                      <span key={attachment.id}>
                        📎 {attachment.name}
                        <em>{Math.ceil(attachment.size / 1024)} KB</em>
                      </span>
                    ))}
                  </div>
                ) : null}

                <ComposeActionFooter controller={controller} />
              </>
            ) : null}
            {composeEncryptionModalOpen ? (
              <>
                <div className="nt-compose-encryption-modal-backdrop" aria-hidden="true" />
                <ComposeEncryptionDialog controller={controller} />
              </>
            ) : null}
          </section>
        </>
      ) : null}
      {composeExpirationModalOpen ? (
        <>
          <div className="nt-compose-expiration-modal-backdrop" aria-hidden="true" />
          <ComposeExpirationDialog controller={controller} />
        </>
      ) : null}
      <input
        ref={composeImageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={handleComposeImageFile}
      />
      <input
        ref={composeAttachmentInputRef}
        type="file"
        multiple
        hidden
        onChange={handleComposeAttachmentFiles}
      />
      {composeLinkModalOpen ? (
        <>
          <div className="nt-compose-link-modal-backdrop" aria-hidden="true" />
          <ComposeLinkDialog controller={controller} />
        </>
      ) : null}
      {mailTaxonomyManagerKind ? (
        <>
          <div className="nt-mail-taxonomy-modal-backdrop" aria-hidden="true" />
          <MailTaxonomyDialog controller={controller} />
        </>
      ) : null}
      {contactModalOpen ? (
        <>
          <div className="nt-contact-modal-backdrop" aria-hidden="true" />
          <ContactDialog controller={controller} />
        </>
      ) : null}
      {composeRecipientMenu ? (
        <>
          <div
            className="nt-compose-recipient-menu-backdrop"
            aria-hidden="true"
            onClick={() => setComposeRecipientMenu(null)}
          />
          <ComposeRecipientMenu controller={controller} />
        </>
      ) : null}
    </>
  );
}
