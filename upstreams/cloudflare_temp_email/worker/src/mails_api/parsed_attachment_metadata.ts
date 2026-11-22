interface ParsedAttachment { filename: string; mimeType: string; disposition: string; content: Uint8Array }

// Additive contract: legacy clients can ignore index/sha256. Bound hashing, not the old metadata list.
export async function parsedAttachmentMetadata(attachments: ParsedAttachment[]) {
    const result = [];
    for (const [index, item] of attachments.entries()) {
        const sha256 = index < 100
            ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(item.content).buffer)))
                .map(value => value.toString(16).padStart(2, '0')).join('')
            : undefined;
        result.push({ filename: item.filename, mimeType: item.mimeType, disposition: item.disposition,
            size: item.content.length, index, ...(sha256 ? { sha256 } : {}) });
    }
    return result;
}
