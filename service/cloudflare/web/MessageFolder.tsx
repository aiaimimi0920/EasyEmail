import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { folderOptions, loadFolders, type Folder } from "./folders-api";
import { useOrganization } from "./useOrganization";
import { OrganizationStatus } from "./OrganizationStatus";
import type { TaxonomyController } from "./labels-api";

export function MessageFolder({ path, id, onChanged, controller }: { path: string; id: string; onChanged?: () => void; controller?: TaxonomyController }) {
  const [folders, setFolders] = useState<Folder[]>([]), [current, setCurrent] = useState<Folder | null>(null), [target, setTarget] = useState("");
  const [revision, setRevision] = useState(0), [pending, setPending] = useState(true), [error, setError] = useState("");
  const fallback = useOrganization(() => { setRevision(value => value + 1); onChanged?.(); }), action = controller ?? fallback;
  useEffect(() => {
    let active = true; setPending(true); setError("");
    Promise.all([loadFolders(), api<{ folder: Folder | null }>(`${path}/folder`)]).then(([all, placement]) => {
      if (active) { setFolders(all.items); setCurrent(placement.folder); setTarget(placement.folder?.id ?? ""); }
    }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, [path, revision, controller?.revision]);
  return <section aria-label="邮件文件夹"><h4>邮件文件夹</h4>
    <p>当前位置：{current?.name ?? "默认位置"}</p>
    <div className="row"><label>移动到文件夹<select disabled={pending || action.locked} value={target} onChange={event => setTarget(event.target.value)}>
      <option value="">默认收件箱</option>{folderOptions(folders).map(({ folder, path: name }) => <option key={folder.id} value={folder.id}>{name}</option>)}</select></label>
      <button disabled={pending || action.locked || (target !== "" && !folders.some(folder => folder.id === target))}
        onClick={() => action.submit([id], { folderId: target || null })}>移动此邮件</button></div>
    {error && <p role="alert">{error}</p>}{!controller && <OrganizationStatus action={fallback} />}
  </section>;
}
