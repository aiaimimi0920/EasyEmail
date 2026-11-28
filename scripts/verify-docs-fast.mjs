import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walkMarkdownFiles(dir, collected = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".tmp" || entry.name === "upstreams") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, collected);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      collected.push(full);
    }
  }
  return collected;
}

const mdFiles = [
  ...(fs.existsSync(path.join(repoRoot, "README.md")) ? [path.join(repoRoot, "README.md")] : []),
  ...(fs.existsSync(path.join(repoRoot, "AGENTS.md")) ? [path.join(repoRoot, "AGENTS.md")] : []),
  ...(fs.existsSync(path.join(repoRoot, "docs")) ? walkMarkdownFiles(path.join(repoRoot, "docs")) : []),
];

const LINK_RE = /(?<!!)\[[^\]]+\]\(([^)#\s]+)(?:#[^)]*)?\)/g;
const broken = [];

for (const file of mdFiles) {
  const raw = fs.readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of raw.matchAll(LINK_RE)) {
    const target = match[1]?.trim() ?? "";
    if (
      !target ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:") ||
      target.startsWith("file://") ||
      target.startsWith("conversation://")
    ) {
      continue;
    }
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    const relToRoot = path.relative(repoRoot, resolved);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      continue;
    }
    if (!fs.existsSync(resolved)) {
      broken.push(`${path.relative(repoRoot, file)} -> ${target}`);
    }
  }
}

if (broken.length > 0) {
  console.error(`Broken relative Markdown links (${broken.length}):\n${broken.join("\n")}`);
  process.exit(1);
}

fs.mkdirSync(path.join(repoRoot, ".tmp"), { recursive: true });
execFileSync(
  process.execPath,
  [
    path.join(repoRoot, "scripts", "effective-code-lines.mjs"),
    "--mode",
    "ratchet",
    "--json",
    path.join(repoRoot, ".tmp", "effective-code-lines.json"),
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

console.log(`Fast documentation verification passed (${mdFiles.length} Markdown files checked).`);
