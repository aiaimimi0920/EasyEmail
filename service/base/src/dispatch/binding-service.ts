import type {
  BindingMode,
  BindingResolution,
  HostBinding,
  MailProviderTypeKey,
  ProviderInstance,
} from "../domain/models.js";
import { MailRegistry } from "../domain/registry.js";

export interface BindHostInput {
  hostId: string;
  providerTypeKey: MailProviderTypeKey;
  instance: ProviderInstance;
  bindingMode: BindingMode;
  groupKey?: string;
  now: Date;
}

export class MailboxBindingService {
  public constructor(private readonly registry: MailRegistry) {}

  public resolve(
    hostId: string,
    providerTypeKey: MailProviderTypeKey,
    bindingMode?: BindingMode,
  ): ProviderInstance | undefined {
    const binding = this.registry.findBinding(hostId, providerTypeKey);

    if (!binding) {
      return undefined;
    }

    if (bindingMode && binding.bindingMode !== bindingMode) {
      return undefined;
    }

    const instance = this.registry.findInstanceById(binding.instanceId);
    if (!instance) {
      return undefined;
    }

    if (instance.status === "offline" || instance.status === "cooling") {
      return undefined;
    }

    if (binding.bindingMode === "shared-instance" && instance.status !== "active") {
      return undefined;
    }

    return instance;
  }

  public preview(input: BindHostInput): BindingResolution {
    const existing = this.registry.findBinding(input.hostId, input.providerTypeKey);
    const binding: HostBinding = {
      hostId: input.hostId,
      providerTypeKey: input.providerTypeKey,
      bindingMode: input.bindingMode,
      instanceId: input.instance.id,
      groupKey: input.groupKey,
      updatedAt: input.now.toISOString(),
    };

    return {
      binding,
      reusedExistingBinding: existing?.instanceId === input.instance.id,
    };
  }

  public bind(input: BindHostInput): BindingResolution {
    const resolution = this.preview(input);
    this.registry.saveBinding(resolution.binding);

    const instance = this.registry.findInstanceById(input.instance.id) ?? input.instance;

    if (
      resolution.reusedExistingBinding === false
      || instance.hostBindings.includes(input.hostId) === false
    ) {
      this.registry.saveInstance({
        ...instance,
        hostBindings: [...new Set([...instance.hostBindings, input.hostId])],
        groupKeys: input.groupKey
          ? [...new Set([...instance.groupKeys, input.groupKey])]
          : [...instance.groupKeys],
        updatedAt: input.now.toISOString(),
      });
    }

    return resolution;
  }
}
