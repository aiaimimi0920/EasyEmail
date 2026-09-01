import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repositoryRoot = resolve(desktopRoot, "..", "..");
const serviceRoot = join(repositoryRoot, "service", "base");
const outputRoot = join(desktopRoot, "src-tauri", "resources", "core");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function requirePath(path, description) {
  if (!existsSync(path)) {
    throw new Error(`${description} is missing: ${path}`);
  }
}

execFileSync(npmCommand, ["run", "build"], {
  cwd: serviceRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

const serviceDist = join(serviceRoot, "dist");
const yamlPackage = join(serviceRoot, "node_modules", "yaml");
requirePath(serviceDist, "Compiled service/base output");
requirePath(yamlPackage, "service/base runtime dependency (run npm ci in service/base)");
requirePath(process.execPath, "Node.js runtime");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(join(outputRoot, "node_modules"), { recursive: true });
writeFileSync(join(outputRoot, ".gitkeep"), "", "utf8");
cpSync(serviceDist, join(outputRoot, "dist"), { recursive: true });
cpSync(yamlPackage, join(outputRoot, "node_modules", "yaml"), { recursive: true });
cpSync(join(serviceRoot, "package.json"), join(outputRoot, "package.json"));
cpSync(process.execPath, join(outputRoot, process.platform === "win32" ? "node.exe" : "node"));

const manifest = {
  schemaVersion: 1,
  component: "easyemail-service-base-desktop-core",
  sourceRevision: process.env.GITHUB_SHA || "workspace",
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  entry: "dist/src/runtime/main.js",
  runtime: process.platform === "win32" ? "node.exe" : "node",
};
writeFileSync(
  join(outputRoot, "runtime-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(`Bundled EasyEmail core at ${outputRoot}`);
