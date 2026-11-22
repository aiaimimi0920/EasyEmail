import { HttpError, readJson } from "./http";
import { taxonomyFields, taxonomyRevision } from "./taxonomy-input";
export { TAXONOMY_UUID as LABEL_UUID, TAXONOMY_COLORS as LABEL_COLORS } from "./taxonomy-input";

export interface LabelInput { name: string; nameKey: string; color: string; expectedRevision: number }

export function labelRevision(value: unknown, minimum = 0): number {
  return taxonomyRevision(value, "invalid_label_request", minimum);
}

export async function labelInput(request: Request): Promise<LabelInput> {
  const body = await readJson(request);
  if (Object.keys(body).some(key => !["name", "color", "expectedRevision"].includes(key))) throw new HttpError(400, "invalid_label_request");
  return taxonomyFields(body, "invalid_label_request");
}
