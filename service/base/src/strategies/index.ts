import type { ProviderInstance, StrategyProfile, StrategyKey, VerificationMailboxRequest } from "../domain/models.js";

export interface StrategySelectionInput {
  request: VerificationMailboxRequest;
  profile: StrategyProfile;
  instances: ProviderInstance[];
}

export interface DispatchStrategy {
  readonly key: StrategyKey;
  choose(input: StrategySelectionInput): ProviderInstance | undefined;
}

function sortByHealthThenLatency(instances: ProviderInstance[]): ProviderInstance[] {
  return [...instances].sort((left, right) => {
    if (right.healthScore !== left.healthScore) {
      return right.healthScore - left.healthScore;
    }

    return left.averageLatencyMs - right.averageLatencyMs;
  });
}

export class FreeFirstStrategy implements DispatchStrategy {
  public readonly key = "free-first" as const;

  public choose(input: StrategySelectionInput): ProviderInstance | undefined {
    return [...input.instances]
      .sort((left, right) => {
        if (left.costTier !== right.costTier) {
          return left.costTier === "free" ? -1 : 1;
        }

        if (right.healthScore !== left.healthScore) {
          return right.healthScore - left.healthScore;
        }

        return left.averageLatencyMs - right.averageLatencyMs;
      })[0];
  }
}

export class DynamicPriorityStrategy implements DispatchStrategy {
  public readonly key = "dynamic-priority" as const;

  public choose(input: StrategySelectionInput): ProviderInstance | undefined {
    return sortByHealthThenLatency(input.instances)[0];
  }
}

export class RandomPriorityStrategy implements DispatchStrategy {
  public readonly key = "random-priority" as const;

  public choose(input: StrategySelectionInput): ProviderInstance | undefined {
    const candidates = [...input.instances];

    if (candidates.length === 0) {
      return undefined;
    }

    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index];
  }
}

export class CustomPriorityStrategy implements DispatchStrategy {
  public readonly key = "custom-priority" as const;

  public choose(input: StrategySelectionInput): ProviderInstance | undefined {
    const orderedIds = input.profile.preferredInstanceIds ?? [];
    const ranked = [...input.instances].sort((left, right) => {
      const leftIndex = orderedIds.indexOf(left.id);
      const rightIndex = orderedIds.indexOf(right.id);

      if (leftIndex === -1 && rightIndex === -1) {
        return 0;
      }

      if (leftIndex === -1) {
        return 1;
      }

      if (rightIndex === -1) {
        return -1;
      }

      return leftIndex - rightIndex;
    });

    return ranked[0] ?? sortByHealthThenLatency(input.instances)[0];
  }
}

export class DispatchStrategyRegistry {
  private readonly strategies = new Map<StrategyKey, DispatchStrategy>();

  public constructor(items: DispatchStrategy[]) {
    for (const strategy of items) {
      this.strategies.set(strategy.key, strategy);
    }
  }

  public resolve(key: StrategyKey): DispatchStrategy | undefined {
    return this.strategies.get(key);
  }
}

export function createDefaultDispatchStrategyRegistry(): DispatchStrategyRegistry {
  return new DispatchStrategyRegistry([
    new FreeFirstStrategy(),
    new DynamicPriorityStrategy(),
    new RandomPriorityStrategy(),
    new CustomPriorityStrategy(),
  ]);
}
