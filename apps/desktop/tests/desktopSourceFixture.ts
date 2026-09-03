import { existsSync, readFileSync, readdirSync } from "node:fs";

function filesUnder(directory: URL): URL[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => {
      const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) return filesUnder(path);
      return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

export function readAppImplementationSource(): string {
  const appSource = new URL("../src/App.tsx", import.meta.url);
  const implementationSources = filesUnder(new URL("../src/app/", import.meta.url));
  const componentSources = filesUnder(new URL("../src/components/", import.meta.url));
  return [appSource, ...implementationSources, ...componentSources]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
    .replace(/\r\n/g, "\n");
}

export function readDesktopSourceFile(pathFromSrc: string): string {
  return readFileSync(new URL(`../src/${pathFromSrc}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}
