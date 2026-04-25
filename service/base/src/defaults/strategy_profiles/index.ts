import customPriority from "./custom-priority.json" with { type: "json" };
import dynamicPriority from "./dynamic-priority.json" with { type: "json" };
import freeFirst from "./free-first.json" with { type: "json" };
import randomPriority from "./random-priority.json" with { type: "json" };
import type { StrategyProfile } from "../../domain/models.js";
import { toStrategyProfile } from "../validation.js";

export const DEFAULT_STRATEGY_PROFILES: StrategyProfile[] = [
  toStrategyProfile(freeFirst, "strategy_profiles.free-first"),
  toStrategyProfile(dynamicPriority, "strategy_profiles.dynamic-priority"),
  toStrategyProfile(randomPriority, "strategy_profiles.random-priority"),
  toStrategyProfile(customPriority, "strategy_profiles.custom-priority"),
];
