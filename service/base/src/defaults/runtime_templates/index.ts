import dedicated from "./cloudflare_temp_email-dedicated.json" with { type: "json" };
import worker from "./cloudflare_temp_email-worker.json" with { type: "json" };
import type { RuntimeTemplate } from "../../domain/models.js";
import { toRuntimeTemplate } from "../validation.js";

export const DEFAULT_RUNTIME_TEMPLATES: RuntimeTemplate[] = [
  toRuntimeTemplate(worker, "runtime_templates.cloudflare_temp_email-worker"),
  toRuntimeTemplate(dedicated, "runtime_templates.cloudflare_temp_email-dedicated"),
];
