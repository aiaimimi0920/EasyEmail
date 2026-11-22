import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

// This entry can only build a synthetic local Worker; it never deploys or reads root config.yaml.
export async function buildLocalWorker(output) {
  if (!output || !path.isAbsolute(output)) throw Error("An absolute isolated output directory is required");
  await mkdir(output, { recursive: true });
  const config = path.join(output, "wrangler.local.json"), bundle = path.join(output, "bundle");
  await mkdir(bundle);
  await writeFile(config, JSON.stringify({ name: "easyemail-upstream-local", main: path.join(workerRoot, "src/worker.ts"),
    compatibility_date: "2025-04-01", compatibility_flags: ["nodejs_compat"], workers_dev: false,
    d1_databases: [{ binding: "DB", database_name: "easyemail-upstream-local", database_id: "00000000-0000-0000-0000-000000000001" }],
    vars: { DOMAINS: ["cf.example.test"], JWT_SECRET: "synthetic-local-build-secret-not-for-production" } }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  const wranglerPackage = require.resolve("wrangler/package.json");
  const wranglerMetadata = JSON.parse(await readFile(wranglerPackage, "utf8"));
  const wranglerCli = path.resolve(path.dirname(wranglerPackage), wranglerMetadata.bin.wrangler);
  const result = spawnSync(process.execPath, [wranglerCli, "deploy", "--dry-run",
    "--config", config, "--outdir", bundle], { cwd: output, encoding: "utf8", timeout: 180000,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" }, maxBuffer: 8 * 1024 * 1024 });
  await writeFile(path.join(output, "build.stdout.log"), result.stdout || "", "utf8");
  await writeFile(path.join(output, "build.stderr.log"), result.stderr || "", "utf8");
  if (result.status !== 0) throw Error(`Local Worker build failed: ${result.error?.message || result.stderr || result.stdout}`);
  const scriptPath = path.join(bundle, "worker.js");
  await readFile(scriptPath);
  return { scriptPath, modulesRoot: bundle };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error("Usage: node scripts/build-local.mjs <absolute-output-directory>");
  console.log(JSON.stringify(await buildLocalWorker(process.argv[2])));
}
