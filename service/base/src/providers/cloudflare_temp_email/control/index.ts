import type { ProviderInstance, RuntimeTemplate, CloudflareTempEmailRuntimePlan } from "../../../domain/models.js";

export class CloudflareTempEmailRuntimeController {
  public createRuntimePlan(instance: ProviderInstance, template: RuntimeTemplate): CloudflareTempEmailRuntimePlan {
    return {
      instanceId: instance.id,
      templateId: template.id,
      roleKey: template.roleKey,
      deploymentMode: instance.shared ? "shared" : "dedicated",
      config: {
        connectionRef: instance.connectionRef,
        baseUrl: instance.metadata.baseUrl ?? template.metadata.baseUrl ?? "",
        customAuth: instance.metadata.customAuth ?? template.metadata.customAuth ?? "",
        domain: instance.metadata.domain ?? template.metadata.domain ?? "cloudflare-temp-email.local",
        deploymentTarget: instance.metadata.deploymentTarget ?? template.metadata.deploymentTarget ?? "worker-node",
        templateDisplayName: template.displayName,
        shared: String(instance.shared),
      },
    };
  }
}
