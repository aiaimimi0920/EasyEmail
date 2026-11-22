import { HttpError, readJson } from "./http";
import { taxonomyFields, TAXONOMY_UUID } from "./taxonomy-input";

export interface FolderInput { name: string; nameKey: string; color: string; parentId: string | null; expectedRevision: number }

export async function folderInput(request: Request): Promise<FolderInput> {
  const body = await readJson(request), parentId = body.parentId ?? null;
  if (Object.keys(body).some(key => !["name", "color", "parentId", "expectedRevision"].includes(key))
    || (parentId !== null && (typeof parentId !== "string" || !TAXONOMY_UUID.test(parentId)))) throw new HttpError(400, "invalid_folder_request");
  return { ...taxonomyFields(body, "invalid_folder_request"), parentId: parentId as string | null };
}
