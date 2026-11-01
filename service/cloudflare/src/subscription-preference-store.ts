import type { Env } from "./contracts";

interface PreferenceWrite {
  preferences: string; operations: string; owner: Record<string, string>; metadata?: Record<string, number>;
  exists: string; existsValues: (string | number)[]; requestKey: string; hash: string; id: string; now: number; expectedVersion: number; hidden: boolean;
}
// Descriptors are internal SQL identifiers, never request input. All values stay bound.
export function subscriptionPreferenceStatements(env: Env, input: PreferenceWrite) {
  const { preferences, operations, owner, metadata = {}, exists, existsValues, requestKey, hash, id, now, expectedVersion, hidden } = input;
  const columns = Object.keys(owner), values = Object.values(owner), ownerWhere = columns.map(key => `${key}=?`).join(" AND ");
  const operation = { ...owner, ...metadata, request_key: requestKey, id, request_hash: hash, hidden: Number(hidden), created_at: now };
  const guard = `EXISTS(SELECT 1 FROM ${operations} WHERE id=? AND completed_at IS NULL)`;
  return [
    env.DB.prepare(`INSERT INTO ${operations}(${Object.keys(operation).join(",")})
      SELECT ${Object.keys(operation).map(() => "?").join(",")} WHERE ${exists}
      AND COALESCE((SELECT version FROM ${preferences} WHERE ${ownerWhere}),0)=?
      ON CONFLICT(user_id,request_key) DO NOTHING`).bind(...Object.values(operation), ...existsValues, ...values, expectedVersion),
    env.DB.prepare(`INSERT INTO ${preferences}(${columns.join(",")},hidden,version,updated_at)
      SELECT ${columns.map(() => "?").join(",")},?,1,? WHERE ${guard} ON CONFLICT(${columns.join(",")}) DO UPDATE
      SET hidden=excluded.hidden,version=${preferences}.version+1,updated_at=excluded.updated_at
      WHERE ${preferences}.version=? AND ${guard}`).bind(...values, Number(hidden), now, id, expectedVersion, id),
    env.DB.prepare(`UPDATE ${operations} SET version=(SELECT version FROM ${preferences} WHERE ${ownerWhere}),completed_at=?
      WHERE id=? AND completed_at IS NULL`).bind(...values, now, id),
  ];
}
