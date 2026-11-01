import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildApplication(output) {
  await mkdir(path.join(output, "web/assets"), { recursive: true });
  await build({
    entryPoints: [path.join(root, "src/worker.ts")],
    outfile: path.join(output, "worker.mjs"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["node:crypto", "cloudflare:sockets"],
    sourcemap: true,
    logLevel: "info",
  });
  await build({
    entryPoints: [path.join(root, "web/app.tsx")],
    outfile: path.join(output, "web/assets/app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "info",
  });
  await copyFile(path.join(root, "web/index.html"), path.join(output, "web/index.html"));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await buildApplication(path.resolve(process.argv[2] ?? path.join(root, "dist")));
}
