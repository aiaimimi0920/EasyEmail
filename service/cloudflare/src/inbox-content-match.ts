import type { inboxQuery } from "./inbox-query";

export function inboxContentMatch(filters: Awaited<ReturnType<typeof inboxQuery>>["filters"]) {
  const matches: string[] = [], matchValues: (string | number)[] = [];
  const add = (sql: string, ...bindings: (string | number)[]) => { matches.push(sql); matchValues.push(...bindings); };
  if (filters.since !== null) add("m.received_at>=?", filters.since);
  if (filters.until !== null) add("m.received_at<=?", filters.until);
  if (filters.sender) add("instr(lower(m.sender),lower(?))>0", filters.sender);
  if (filters.recipient) add("instr(lower(m.recipient),lower(?))>0", filters.recipient);
  if (filters.q) add(`(instr(lower(m.subject),lower(?))>0 OR instr(lower(m.sender),lower(?))>0 OR instr(lower(m.recipient),lower(?))>0
    OR instr(lower(m.text_body),lower(?))>0 OR instr(lower(m.html_body),lower(?))>0)`, ...Array<string>(5).fill(filters.q));
  return { matches: matches.join(" AND ") || "1", matchValues };
}
