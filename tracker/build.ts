// Minifies the website script. The ingest service builds it in memory at start; `npm run build` writes
// tracker/dist/s.js and reports its size, failing over the 2 KB budget.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { transform } from "esbuild";

export const BUDGET = 2048;

export async function buildTracker(): Promise<string> {
  const source = readFileSync(new URL("src/script.js", import.meta.url), "utf8");
  const { code } = await transform(source, { minify: true, target: "es2017", legalComments: "none" });
  return code;
}

if (import.meta.main) {
  const code = await buildTracker();
  mkdirSync(new URL("dist/", import.meta.url), { recursive: true });
  writeFileSync(new URL("dist/s.js", import.meta.url), code);
  const bytes = Buffer.byteLength(code);
  console.log(`tracker/dist/s.js: ${bytes} bytes, ${gzipSync(code).length} gzipped (budget ${BUDGET})`);
  if (bytes > BUDGET) process.exit(1);
}
