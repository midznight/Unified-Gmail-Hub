import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const assets = [
  ["/index.html", "index.html", "text/html; charset=utf-8"],
  ["/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"],
  ["/sw.js", "sw.js", "text/javascript; charset=utf-8"],
  ["/offline.html", "offline.html", "text/html; charset=utf-8"],
  ["/icon.svg", "icon.svg", "image/svg+xml"],
];

const entries = {};
for (const [route, filename, contentType] of assets) {
  entries[route] = {
    contentType,
    body: await readFile(join(root, "public", filename), "utf8"),
  };
}

const generated = `export const INLINE_ASSETS = Object.freeze(${JSON.stringify(entries)});\n`;
const target = join(root, "src", "inline-assets.js");

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8");
  if (current !== generated) {
    console.error("src/inline-assets.js is out of date. Run npm run build:inline-assets.");
    process.exitCode = 1;
  } else {
    console.log("Bundled PWA assets are synchronized with public/.");
  }
} else {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(target, generated, "utf8");
  console.log(`Generated src/inline-assets.js (${generated.length} bytes).`);
}
