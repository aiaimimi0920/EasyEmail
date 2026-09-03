import { Context } from 'hono';

import { getAnotherWorkerList, getBooleanValue } from './utils';
import { CONSTANTS } from './constants';
import { AdminWebhookSettings, WebhookMail, WebhookSettings } from './models';

export const commonParseMail = async (parsedEmailContext: ParsedEmailContext): Promise<{
    sender: string,
    subject: string,
    text: string,
    html: string,
    headers?: Record<string, string>[],
    attachments?: ParsedEmailAttachment[],
} | undefined> => {
    // check parsed email context is valid
    if (!parsedEmailContext || !parsedEmailContext.rawEmail) {
        return undefined;
    }
    // return parsed email if already parsed
    if (parsedEmailContext.parsedEmail) {
        return parsedEmailContext.parsedEmail;
    }
    const raw_mail = parsedEmailContext.rawEmail;
    // NOTE: WASM parse email
    // try {
    //     const { parse_message_wrapper } = await import('mail-parser-wasm-worker');

    //     const parsedEmail = parse_message_wrapper(raw_mail);
    //     parsedEmailContext.parsedEmail = {
    //         sender: parsedEmail.sender || "",
    //         subject: parsedEmail.subject || "",
    //         text: parsedEmail.text || "",
    //         headers: parsedEmail.headers?.map(
    //             (header) => ({ key: header.key, value: header.value })
    //         ) || [],
    //         html: parsedEmail.body_html || "",
    //         attachments: (parsedEmail.attachments || []).map(att => ({
    //             filename: att.filename || "attachment",
    //             mimeType: att.content_type || "application/octet-stream",
    //             content: att.content,
    //             disposition: "attachment",
    //         })),
    //     };
    //     return parsedEmailContext.parsedEmail;
    // } catch (e) {
    //     console.error("Failed use mail-parser-wasm-worker to parse email", e);
    // }
    try {
        const { default: PostalMime } = await import('postal-mime');
        const parsedEmail = await PostalMime.parse(raw_mail);
        parsedEmailContext.parsedEmail = {
            sender: parsedEmail.from ? `${parsedEmail.from.name} <${parsedEmail.from.address}>` : "",
            subject: parsedEmail.subject || "",
            text: parsedEmail.text || "",
            html: parsedEmail.html || "",
            headers: parsedEmail.headers || [],
            attachments: (parsedEmail.attachments || []).map(att => ({
                filename: att.filename || "attachment",
                mimeType: att.mimeType || "application/octet-stream",
                content: new Uint8Array(att.content),
                disposition: att.disposition || "attachment",
            })),
        };
        return parsedEmailContext.parsedEmail;
    }
    catch (e) {
        console.error("Failed use PostalMime to parse email", e);
    }
    return undefined;
}

export async function sendWebhook(
    settings: WebhookSettings, formatMap: WebhookMail
): Promise<{ success: boolean, message?: string }> {
    // send webhook
    let body = settings.body;
    for (const key of Object.keys(formatMap)) {
        body = body.replace(
            new RegExp(`\\$\\{${key}\\}`, "g"),
            JSON.stringify(
                formatMap[key as keyof WebhookMail]
            ).replace(/^"(.*)"$/, '$1')
        );
    }
    const response = await fetch(settings.url, {
        method: settings.method,
        headers: JSON.parse(settings.headers),
        body: body
    });
    if (!response.ok) {
        console.log("send webhook error", settings.url, settings.method, settings.headers, body);
        console.log("send webhook error", response.status, response.statusText);
        return { success: false, message: `send webhook error: ${response.status} ${response.statusText}` };
    }
    return { success: true }
}

export async function triggerWebhook(
    c: Context<HonoCustomType>,
    address: string,
    parsedEmailContext: ParsedEmailContext,
    message_id: string | null
): Promise<void> {
    if (!c.env.KV || !getBooleanValue(c.env.ENABLE_WEBHOOK)) {
        return
    }
    const webhookList: WebhookSettings[] = []

    // admin mail webhook
    const adminMailWebhookSettings = await c.env.KV.get<WebhookSettings>(CONSTANTS.WEBHOOK_KV_ADMIN_MAIL_SETTINGS_KEY, "json");
    if (adminMailWebhookSettings?.enabled) {
        webhookList.push(adminMailWebhookSettings)
    }

    // user mail webhook
    const adminSettings = await c.env.KV.get<AdminWebhookSettings>(CONSTANTS.WEBHOOK_KV_SETTINGS_KEY, "json");
    if (!adminSettings?.enableAllowList || adminSettings?.allowList.includes(address)) {
        const settings = await c.env.KV.get<WebhookSettings>(
            `${CONSTANTS.WEBHOOK_KV_USER_SETTINGS_KEY}:${address}`, "json"
        );
        if (settings?.enabled) {
            webhookList.push(settings)
        }
    }

    // no webhook
    if (webhookList.length === 0) {
        return
    }
    const mailId = await c.env.DB.prepare(
        `SELECT id FROM raw_mails where address = ? and message_id = ?`
    ).bind(address, message_id).first<string>("id");

    const parsedEmail = await commonParseMail(parsedEmailContext);
    const webhookMail = {
        id: mailId || "",
        url: c.env.FRONTEND_URL ? `${c.env.FRONTEND_URL}?mail_id=${mailId}` : "",
        from: parsedEmail?.sender || "",
        to: address,
        subject: parsedEmail?.subject || "",
        raw: parsedEmailContext.rawEmail || "",
        parsedText: parsedEmail?.text || "",
        parsedHtml: parsedEmail?.html || "",
    }
    for (const settings of webhookList) {
        const res = await sendWebhook(settings, webhookMail);
        if (!res.success) {
            console.error(res.message);
        }
    }
}

export async function triggerAnotherWorker(
    c: Context<HonoCustomType>,
    rpcEmailMessage: RPCEmailMessage,
    parsedText: string | undefined | null
): Promise<void> {
    if (!parsedText) {
        return;
    }

    const anotherWorkerList: AnotherWorker[] = getAnotherWorkerList(c);
    if (!getBooleanValue(c.env.ENABLE_ANOTHER_WORKER) || anotherWorkerList.length === 0) {
        return;
    }

    const parsedTextLowercase: string = parsedText.toLowerCase();
    for (const worker of anotherWorkerList) {

        const keywords = worker?.keywords ?? [];
        const bindingName = worker?.binding ?? "";
        const methodName = worker.method ?? "rpcEmail";

        const serviceBinding = (c.env as any)[bindingName] ?? {};
        const method = serviceBinding[methodName];

        if (!method || typeof method !== "function") {
            console.log(`method = ${methodName} not found or not function`);
            continue;
        }

        if (!keywords.some(keyword => keyword && parsedTextLowercase.includes(keyword.toLowerCase()))) {
            console.log(`worker.binding = ${bindingName} not match keywords, parsedText = ${parsedText}`);
            continue;
        }
        try {
            const bodyObj = { ...rpcEmailMessage } as any;
            if (bodyObj.headers && typeof bodyObj.headers.forEach === "function") {
                const headerObj: any = {}
                bodyObj.headers.forEach((value: string, key: string) => {
                    headerObj[key] = value;
                });
                bodyObj.headers = headerObj
            }
            const requestBody = JSON.stringify(bodyObj);
            console.log(`exec worker , binding = ${bindingName} , requestBody = ${requestBody}`);
            await method(requestBody);
        } catch (e1) {
            console.error(`execute method = ${methodName} error`, e1);
        }
    }
}
