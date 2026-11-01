// Fixture-only SQLite statement framing. Keep trigger BEGIN/CASE/END bodies intact.
export function migrationStatements(sql) {
  const statements = []; let start = 0, quote = null, comment = null, depth = 0, trigger = false, code = false, prefix = [];
  function finish(end) {
    if (code) statements.push(sql.slice(start, end).trim());
    start = end; code = false; prefix = []; trigger = false;
  }
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (comment === "line") { if (c === "\n") comment = null; continue; }
    if (comment === "block") { if (c === "*" && next === "/") { comment = null; i++; } continue; }
    if (quote) {
      if (c === quote) { if (next === quote) i++; else quote = null; }
      continue;
    }
    if (c === "-" && next === "-") { comment = "line"; i++; continue; }
    if (c === "/" && next === "*") { comment = "block"; i++; continue; }
    if (/\s/.test(c)) continue;
    if (c === ";") { if (depth === 0) finish(i + 1); continue; }
    code = true;
    if (["'", '"', "`", "["].includes(c)) { quote = c === "[" ? "]" : c; continue; }
    if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(sql.slice(i))[0].toUpperCase(); i += word.length - 1;
      if (prefix.length < 3) prefix.push(word);
      trigger ||= /^CREATE (?:TEMP |TEMPORARY )?TRIGGER$/.test(prefix.join(" "));
      if (trigger && ["BEGIN", "CASE"].includes(word)) depth++;
      else if (trigger && word === "END") depth--;
      if (depth < 0) throw new Error("Incomplete migration SQL");
    }
  }
  if (quote || comment === "block" || depth !== 0) throw new Error("Incomplete migration SQL");
  finish(sql.length); return statements;
}
