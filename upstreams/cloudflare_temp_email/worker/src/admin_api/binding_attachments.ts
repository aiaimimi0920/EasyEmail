// JSON carries base64, but the native binding must receive bytes. String content
// was delivered as literal base64 text on the production Email Sending binding.
export function bindingAttachments(input: EmailAttachment[]): EmailAttachment[] {
    if (!Array.isArray(input)) throw new TypeError('Invalid attachment list');
    return input.map((item) => {
        if (!item || typeof item.content !== 'string') throw new TypeError('Invalid base64 attachment');
        let decoded: string;
        try { decoded = atob(item.content); }
        catch { throw new TypeError('Invalid base64 attachment'); }
        return { ...item, content: Uint8Array.from(decoded, (character) => character.charCodeAt(0)) };
    });
}
