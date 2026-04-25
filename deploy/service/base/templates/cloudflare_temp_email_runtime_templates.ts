import type { RuntimeTemplate } from "../../../service/base/src/domain/models.js";

export const CLOUDFLARE_TEMP_EMAIL_RUNTIME_TEMPLATES: RuntimeTemplate[] = [
  {
    id: "cloudflare_temp_email_worker_default",
    providerTypeKey: "cloudflare_temp_email",
    displayName: "Cloudflare Temp Email Worker Runtime",
    description: "Deployable shared runtime for verification inbox processing on a managed worker node.",
    roleKey: "mail-cloudflare_temp_email-runtime",
    sharedByDefault: true,
    metadata: {
      domain: "mail.internal.local",
      deploymentTarget: "worker-node",
      baseUrl: "",
      customAuth: "",
    },
  },
  {
    id: "cloudflare_temp_email_dedicated_node",
    providerTypeKey: "cloudflare_temp_email",
    displayName: "Cloudflare Temp Email Dedicated Runtime",
    description: "Deployable dedicated runtime for verification inbox processing on an isolated node.",
    roleKey: "mail-cloudflare_temp_email-runtime",
    sharedByDefault: false,
    metadata: {
      domain: "mail.dedicated.local",
      deploymentTarget: "dedicated-node",
      baseUrl: "",
      customAuth: "",
    },
  },
];
