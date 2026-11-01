// Only the two thread fields are exposed, never arbitrary raw mail headers.
export function parsedThreadHeaders(headers: Record<string, string>[] = []) {
    let limited = false;
    const field = (name: string) => {
        const values = headers.filter(header => header.key?.toLowerCase() === name).map(header => header.value ?? '');
        const joined = values.join(' ').replace(/\r?\n[ \t]+/g, ' ');
        if (joined.length > 8192 || /[\r\n\x00]/.test(joined)) { limited = true; return ''; }
        return joined;
    };
    const inReplyTo = field('in-reply-to'), references = field('references');
    return { version: 1, inReplyTo, references, limited };
}
