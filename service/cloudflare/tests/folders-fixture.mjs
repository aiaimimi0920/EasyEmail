export { labelsFixture as foldersFixture, organize, expect, seedMessage } from "./labels-fixture.mjs";
export const folderPath = id => `/api/v1/folders${id ? `/${id}` : ""}`;
export const folderBody = (name = "项目", parentId = null, expectedRevision = 0, color = "blue") => ({ name, parentId, expectedRevision, color });
export const putFolder = (h, user, id, body = folderBody(), extra = {}) => h.request(folderPath(id), { cookie: user.cookie, method: "PUT", body, ...extra });
export const deleteFolder = (h, user, id, expectedRevision, extra = {}) => h.request(folderPath(id), { cookie: user.cookie, method: "DELETE", body: { expectedRevision }, ...extra });
export const messageFolder = (h, user, box, id, extra = {}) => h.request(`/api/v1/mailboxes/${box}/messages/${id}/folder`, { cookie: user.cookie, ...extra });
