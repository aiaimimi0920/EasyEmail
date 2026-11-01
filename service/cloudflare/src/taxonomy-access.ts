import type { Env, Identity } from "./contracts";
import { requireScope } from "./identity";
import { requireLabel } from "./label-store";
import { requireFolder } from "./folder-store";

export interface TaxonomyFilters { labelId?: string; folderId?: string }
export async function requireTaxonomyFilters(env: Env, identity: Identity, filters: TaxonomyFilters) {
  if (filters.labelId) { requireScope(identity, "labels:read"); await requireLabel(env, identity, filters.labelId); }
  if (filters.folderId) { requireScope(identity, "folders:read"); await requireFolder(env, identity, filters.folderId); }
}
