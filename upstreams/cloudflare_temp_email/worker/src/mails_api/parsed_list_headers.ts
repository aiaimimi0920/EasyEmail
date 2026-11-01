// An allowlist, not an arbitrary header forwarding endpoint.
export function parsedListHeaders(headers: Record<string, string>[] = []) {
    let limited = false;
    const field = (name: string) => {
        const joined = headers.filter(header => header.key?.toLowerCase() === name).map(header => header.value ?? '').join(' ').replace(/\r?\n[ \t]+/g, ' ');
        if (joined.length > 8192 || /[\r\n\x00]/.test(joined)) { limited = true; return ''; }
        return joined;
    };
    const values = { listId: field('list-id'), unsubscribe: field('list-unsubscribe'), unsubscribePost: field('list-unsubscribe-post'),
        precedence: field('precedence'), listPost: field('list-post'), listHelp: field('list-help'), feedbackId: field('feedback-id') };
    return { version: 1, ...values, limited };
}
