import { HttpError, readJson } from "./http";
import { LABEL_UUID } from "./label-input";

export interface OrganizationInput {
  messageIds: string[]; isRead: boolean | null; starred: boolean | null; archived: boolean | null; trashed: boolean | null;
  addLabelIds: string[]; removeLabelIds: string[];
  folderId?: string | null;
}

function ids(value: unknown, max: number, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > max || (required && !value.length)
    || value.some(id => typeof id !== "string" || !LABEL_UUID.test(id)) || new Set(value).size !== value.length) throw new HttpError(400, "invalid_organization_request");
  return [...value].sort();
}

export async function organizationInput(request: Request): Promise<OrganizationInput> {
  const body = await readJson(request);
  if (Object.keys(body).some(key => !["messageIds", "isRead", "starred", "archived", "trashed", "addLabelIds", "removeLabelIds", "folderId"].includes(key))) throw new HttpError(400, "invalid_organization_request");
  const hasFolder = Object.hasOwn(body, "folderId");
  if (hasFolder && ((body.folderId !== null && (typeof body.folderId !== "string" || !LABEL_UUID.test(body.folderId)))
    || Object.hasOwn(body, "archived"))) throw new HttpError(400, "invalid_organization_request");
  const boolean = (key: string) => {
    if (body[key] === undefined) return null;
    if (typeof body[key] !== "boolean") throw new HttpError(400, "invalid_organization_request");
    return body[key] as boolean;
  };
  const input = { messageIds: ids(body.messageIds, 50, true), isRead: boolean("isRead"), starred: boolean("starred"),
    archived: boolean("archived"), trashed: boolean("trashed"), addLabelIds: ids(body.addLabelIds, 20), removeLabelIds: ids(body.removeLabelIds, 20),
    ...(hasFolder ? { folderId: body.folderId as string | null } : {}) };
  if (input.addLabelIds.some(id => input.removeLabelIds.includes(id)) || (input.isRead === null && input.starred === null
    && input.archived === null && input.trashed === null && !input.addLabelIds.length && !input.removeLabelIds.length && !hasFolder)) throw new HttpError(400, "invalid_organization_request");
  return input;
}

export const organizationScopes = (input: OrganizationInput) => ["messages:write", ...(input.trashed !== null ? ["messages:delete"] : []),
  ...(input.addLabelIds.length || input.removeLabelIds.length ? ["labels:read"] : []), ...(input.folderId !== undefined ? ["folders:read"] : [])];
