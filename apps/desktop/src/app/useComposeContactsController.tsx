import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { type ContactDto } from "../api/contactClient";
import { appendComposeRecipientValue, composeContactPickerAriaLabel, joinComposeAddressList, parseComposeAddressList, type ComposeRecipientField } from "../compose/composeData";
import { extractEmailAddress, displayNameFromAddress } from "../mail/mailSelectors";
import { asErrorDto, optionalValue } from "./appDomain";
import { contactClient } from "./appRuntime";
import type { ComposeContactPickerPosition } from "./appTypes";
import type { AppState } from "./useAppState";

type Dependencies = {
  closeMailSearchOverlay: () => void;
  closeMailListToolbarMenus: () => void;
  closeComposeFormattingPopovers: () => void;
  rememberModalReturnFocus: () => void;
  recipientValueForField: (field: import("../compose/composeData").ComposeRecipientField) => string;
  loadContacts: () => Promise<import("../api/contactClient").ContactDto[]>;
};

export function useComposeContactsController(appState: AppState, dependencies: Dependencies) {
  const {
    composeDraftRevisionRef, setRailMode, setRailModePickerOpen, setMailSourceDropdownOpen, composeDraftHydratedRef, setComposePopoverOpen, setComposePopoverMinimized, setComposeContactPickerField,
    setComposeContactPickerPosition, setComposeCcOpen, setComposeBccOpen, contacts, composeRecipientDrafts, setComposeRecipientMenu, composeContactPickerField, setContactDraftFirstName,
    setContactDraftLastName, setContactDraftDisplayName, setContactDraftEmail, setContactDraftPhone, setContactDraftAddress, setContactDraftBirthday, setContactDraftOrganization, setContactDraftTitle,
    setContactDraftNote, setContactDraftTargetField, setContactModalOpen, setSendTargetAddress, setComposeCcAddress, setComposeBccAddress, setComposeRecipientDrafts, setStatusMessage,
    contactDraftPhone, contactDraftAddress, contactDraftBirthday, contactDraftOrganization, contactDraftTitle, contactDraftNote, composeRecipientMenu, contactDraftDisplayName,
    contactDraftFirstName, contactDraftLastName, contactDraftEmail, setBusy, contactDraftTargetField, setError, composeContactPickerPosition,
  } = appState;
  const {
    closeMailSearchOverlay, closeMailListToolbarMenus, closeComposeFormattingPopovers, rememberModalReturnFocus, recipientValueForField, loadContacts,
  } = dependencies;
  function openComposePopover() {
      composeDraftRevisionRef.current += 1;
      setRailMode("mail");
      setRailModePickerOpen(false);
      closeMailSearchOverlay();
      closeMailListToolbarMenus();
      setMailSourceDropdownOpen(false);
      composeDraftHydratedRef.current = false;
      setComposePopoverOpen(true);
      setComposePopoverMinimized(false);
    }
  function closeComposePopover() {
      composeDraftRevisionRef.current += 1;
      closeComposeFormattingPopovers();
      setComposePopoverOpen(false);
      setComposePopoverMinimized(false);
      setComposeContactPickerField(null);
      setComposeContactPickerPosition(null);
    }
  function contactPickerPositionFromTrigger(
      trigger: HTMLButtonElement,
    ): ComposeContactPickerPosition {
      const rect = trigger.getBoundingClientRect();
      const pickerWidth = 360;
      const viewportPadding = 16;
      const left = Math.max(
        viewportPadding,
        Math.min(rect.left - 260, window.innerWidth - pickerWidth - viewportPadding),
      );
      return {
        left,
        top: rect.bottom + 8,
      };
    }
  function toggleComposeContactPicker(
      field: ComposeRecipientField,
      event?: ReactMouseEvent<HTMLButtonElement>,
    ) {
      if (field === "cc") {
        setComposeCcOpen(true);
      }
      if (field === "bcc") {
        setComposeBccOpen(true);
      }
      if (contacts.length === 0) {
        openContactModal(field, composeRecipientDrafts[field]);
        return;
      }
      setComposeRecipientMenu(null);
      if (composeContactPickerField === field) {
        setComposeContactPickerField(null);
        setComposeContactPickerPosition(null);
        return;
      }
      if (event) {
        setComposeContactPickerPosition(contactPickerPositionFromTrigger(event.currentTarget));
      }
      setComposeContactPickerField(field);
    }
  function resetContactDraft() {
      setContactDraftFirstName("");
      setContactDraftLastName("");
      setContactDraftDisplayName("");
      setContactDraftEmail("");
      setContactDraftPhone("");
      setContactDraftAddress("");
      setContactDraftBirthday("");
      setContactDraftOrganization("");
      setContactDraftTitle("");
      setContactDraftNote("");
    }
  function openContactModal(
      field: ComposeRecipientField | null = composeContactPickerField,
      seedEmail = "",
    ) {
      rememberModalReturnFocus();
      setContactDraftTargetField(field);
      setComposeContactPickerField(null);
      setComposeContactPickerPosition(null);
      setComposeRecipientMenu(null);
      resetContactDraft();
      const normalizedSeed = extractEmailAddress(seedEmail).toLowerCase();
      if (normalizedSeed.length > 0) {
        setContactDraftEmail(normalizedSeed);
        setContactDraftDisplayName(displayNameFromAddress(normalizedSeed));
      }
      setContactModalOpen(true);
    }
  function closeContactModal() {
      setContactModalOpen(false);
      setContactDraftTargetField(null);
      setComposeContactPickerPosition(null);
      resetContactDraft();
    }
  function setRecipientValueForField(
      field: ComposeRecipientField,
      updater: (current: string) => string,
    ) {
      if (field === "to") {
        setSendTargetAddress(updater);
      } else if (field === "cc") {
        setComposeCcAddress(updater);
      } else {
        setComposeBccAddress(updater);
      }
    }
  function setRecipientDraftForField(field: ComposeRecipientField, value: string) {
      setComposeRecipientDrafts((current) => ({ ...current, [field]: value }));
    }
  function commitComposeRecipientDraft(field: ComposeRecipientField, rawValue = composeRecipientDrafts[field]) {
      const tokens = parseComposeAddressList(rawValue);
      if (tokens.length === 0) {
        return;
      }
      setRecipientValueForField(field, (current) =>
        tokens.reduce((next, token) => appendComposeRecipientValue(next, token), current),
      );
      setRecipientDraftForField(field, "");
      setComposeRecipientMenu(null);
    }
  function handleComposeRecipientDraftChange(field: ComposeRecipientField, value: string) {
      const parts = value.split(/([;,\s]+)/);
      const committedTokens: string[] = [];
      let draft = "";
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index] ?? "";
        if (/^[;,\s]+$/.test(part)) {
          if (draft.trim().length > 0) {
            committedTokens.push(draft);
            draft = "";
          }
        } else {
          draft += part;
        }
      }

      if (committedTokens.length > 0) {
        setRecipientValueForField(field, (current) =>
          committedTokens.reduce((next, token) => appendComposeRecipientValue(next, token), current),
        );
      }
      setRecipientDraftForField(field, draft);
    }
  function handleComposeRecipientDraftKeyDown(
      field: ComposeRecipientField,
      event: ReactKeyboardEvent<HTMLInputElement>,
    ) {
      if (
        event.key === "," ||
        event.key === " " ||
        event.key === "Enter" ||
        event.key === "Tab"
      ) {
        const draft = composeRecipientDrafts[field].trim();
        if (draft.length > 0) {
          event.preventDefault();
          commitComposeRecipientDraft(field, draft);
        }
      }
    }
  function removeComposeRecipient(field: ComposeRecipientField, address: string) {
      const normalized = extractEmailAddress(address).toLowerCase();
      setRecipientValueForField(field, (current) =>
        joinComposeAddressList(
          parseComposeAddressList(current).filter(
            (item) => extractEmailAddress(item).toLowerCase() !== normalized,
          ),
        ),
      );
      setComposeRecipientMenu(null);
    }
  function editComposeRecipient(field: ComposeRecipientField, address: string) {
      removeComposeRecipient(field, address);
      setRecipientDraftForField(field, address);
    }
  function copyComposeRecipient(address: string) {
      void navigator.clipboard?.writeText(address).catch(() => undefined);
      setStatusMessage(`Copied ${address}.`);
      setComposeRecipientMenu(null);
    }
  function openComposeRecipientMenu(
      field: ComposeRecipientField,
      address: string,
      event: ReactMouseEvent,
    ) {
      event.preventDefault();
      setComposeContactPickerField(null);
      setComposeRecipientMenu({
        field,
        address,
        x: event.clientX,
        y: event.clientY,
      });
    }
  function buildContactNote() {
      return [
        contactDraftPhone.trim() ? `Phone: ${contactDraftPhone.trim()}` : null,
        contactDraftAddress.trim() ? `Address: ${contactDraftAddress.trim()}` : null,
        contactDraftBirthday.trim() ? `Birthday: ${contactDraftBirthday.trim()}` : null,
        contactDraftOrganization.trim()
          ? `Organization: ${contactDraftOrganization.trim()}`
          : null,
        contactDraftTitle.trim() ? `Title: ${contactDraftTitle.trim()}` : null,
        contactDraftNote.trim() ? `Notes: ${contactDraftNote.trim()}` : null,
      ]
        .filter((item): item is string => item !== null)
        .join("\n");
    }
  function addComposeRecipientFromContact(field: ComposeRecipientField, contact: ContactDto) {
      if (field === "to") {
        setSendTargetAddress((current) => appendComposeRecipientValue(current, contact.email_address));
      } else if (field === "cc") {
        setComposeCcOpen(true);
        setComposeCcAddress((current) => appendComposeRecipientValue(current, contact.email_address));
      } else {
        setComposeBccOpen(true);
        setComposeBccAddress((current) => appendComposeRecipientValue(current, contact.email_address));
      }
      setComposeContactPickerField(null);
      setComposeContactPickerPosition(null);
    }
  function renderComposeRecipientEditor(field: ComposeRecipientField, placeholder: string) {
      const recipients = parseComposeAddressList(recipientValueForField(field));
      const fieldLabel = field.toUpperCase();

      return (
        <div className="nt-compose-recipient-editor" data-recipient-field={field}>
          <div className="nt-compose-recipient-tokens" aria-label={`${fieldLabel} 收件人`}>
            {recipients.map((address) => (
              <span className="nt-compose-recipient-token" key={`${field}:${address}`}>
                <button
                  type="button"
                  className="nt-compose-recipient-token__menu"
                  aria-haspopup="menu"
                  aria-expanded={
                    composeRecipientMenu?.field === field && composeRecipientMenu.address === address
                  }
                  aria-controls="compose-recipient-menu"
                  data-nonmodal-trigger="compose-recipient"
                  onContextMenu={(event) => openComposeRecipientMenu(field, address, event)}
                  onClick={(event) => openComposeRecipientMenu(field, address, event)}
                  title="打开收件人操作"
                >
                  <span>{address}</span>
                </button>
                <button
                  type="button"
                  className="nt-compose-recipient-token__remove"
                  aria-label={`删除${fieldLabel}收件人 ${address}`}
                  onClick={() => removeComposeRecipient(field, address)}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              value={composeRecipientDrafts[field]}
              placeholder={recipients.length > 0 ? "" : placeholder}
              aria-label={`${fieldLabel} 收件人输入框`}
              data-compose-initial-focus={field === "to" ? "true" : undefined}
              onChange={(event) => handleComposeRecipientDraftChange(field, event.currentTarget.value)}
              onKeyDown={(event) => handleComposeRecipientDraftKeyDown(field, event)}
              onBlur={() => commitComposeRecipientDraft(field)}
            />
          </div>
          <button
            type="button"
            aria-label={composeContactPickerAriaLabel(field)}
            aria-haspopup="dialog"
            aria-expanded={composeContactPickerField === field}
            aria-controls="compose-contact-picker"
            title="从联系人中选择"
            data-modal-return-focus="contact"
            data-nonmodal-trigger="compose-contact-picker"
            onClick={(event) => toggleComposeContactPicker(field, event)}
          >
            联系人
          </button>
        </div>
      );
    }
  async function createContactFromDraft() {
      const displayName =
        contactDraftDisplayName.trim() ||
        [contactDraftFirstName.trim(), contactDraftLastName.trim()].filter(Boolean).join(" ") ||
        contactDraftEmail.trim();
      setBusy(true);
      try {
        const contact = await contactClient.createContact({
          display_name: displayName,
          email_address: contactDraftEmail,
          note: optionalValue(buildContactNote()),
        });
        const rows = await loadContacts();
        const savedContact =
          rows.find((row) => row.id === contact.id) ??
          rows.find((row) => row.email_address === contact.email_address) ??
          contact;
        if (contactDraftTargetField) {
          addComposeRecipientFromContact(contactDraftTargetField, savedContact);
        }
        setStatusMessage(`已保存联系人 ${savedContact.email_address}。`);
        setError(null);
        closeContactModal();
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  function renderComposeContactPicker(field: ComposeRecipientField) {
      if (composeContactPickerField !== field) {
        return null;
      }

      return (
        <section
          id="compose-contact-picker"
          className={`nt-compose-contact-picker nt-compose-contact-picker--${field}`}
          style={composeContactPickerPosition ?? undefined}
          role="dialog"
          aria-label="联系人"
          data-nonmodal-layer="compose-contact-picker"
        >
          <header>
            <strong>联系人</strong>
            <span>{field.toUpperCase()}</span>
            <button type="button" onClick={() => openContactModal(field)}>
              新建
            </button>
          </header>
          <div className="nt-compose-contact-list">
            {contacts.length > 0 ? (
              contacts.map((contact) => (
                <button
                  type="button"
                  className="nt-compose-contact-option"
                  key={`${field}:${contact.id}`}
                  onClick={() => addComposeRecipientFromContact(field, contact)}
                >
                  <span className="nt-compose-contact-avatar" aria-hidden="true">
                    {contact.display_name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="nt-compose-contact-main">
                    <strong>{contact.display_name}</strong>
                    <small>{contact.email_address}</small>
                  </span>
                  {contact.note ? <em>{contact.note}</em> : null}
                </button>
              ))
            ) : (
              <button
                type="button"
                className="nt-compose-contact-empty"
                onClick={() => openContactModal(field)}
              >
                新建联系人
              </button>
            )}
          </div>
        </section>
      );
    }
  return {
    openComposePopover, closeComposePopover, openContactModal, closeContactModal, removeComposeRecipient, editComposeRecipient, copyComposeRecipient, renderComposeRecipientEditor,
    createContactFromDraft, renderComposeContactPicker,
  };
}

export type UseComposeContactsControllerResult = ReturnType<typeof useComposeContactsController>;
