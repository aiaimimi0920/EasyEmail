import { startEasyEmailServiceFromConfig } from "./from-config.js";

const runtime = await startEasyEmailServiceFromConfig();
console.log(`[easy_email] HTTP server listening at ${runtime.server.baseUrl}`);
