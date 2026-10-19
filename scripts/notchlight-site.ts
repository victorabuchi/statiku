// Notchlight's website from the lockwidgets repo, served locally with the Waymark snippet added the way it will be on
// notchlight.com, so you can click around it and watch the visits arrive in the dashboard.
//   npm run notchlight [-- --docs ../lockwidgets/docs]   then open http://localhost:8790
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { createProject } from "./project.ts";

export const DEFAULT_DOCS = new URL("../../lockwidgets/docs", import.meta.url).pathname;
export const LOCAL_PROJECT = "Notchlight (local test)";

// The snippet in every page's head, and the download page reporting the download it starts: the same edits that
// go into notchlight.com.
const AUTO_START = "setTimeout(() => { window.location.href = link.href; }, 700);";
export function addSnippet(html: string, path: string, snippet: string) {
  html = html.replace("</head>", `${snippet}\n</head>`);
  if (path.endsWith("download/index.html")) {
    if (!html.includes(AUTO_START)) throw new Error("The download page's auto-start changed; update this script and the live edit.");
    html = html.replace(
      AUTO_START,
      `window.waymark = window.waymark || function () { (waymark.q = waymark.q || []).push(arguments) };
  setTimeout(() => { waymark("download", { props: { file: "Notchlight.dmg" } }); window.location.href = link.href; }, 700);`,
    );
  }
  return html;
}

const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4" };

export function serveDocs(docs: string, snippet: string) {
  return createServer((req, res) => {
    let path = normalize(join(docs, decodeURIComponent((req.url ?? "/").split("?")[0])));
    if (!path.startsWith(docs)) return res.writeHead(403).end();
    try {
      if (statSync(path).isDirectory()) path = join(path, "index.html");
      const body = readFileSync(path);
      const type = TYPES[extname(path)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type, "referrer-policy": "strict-origin-when-cross-origin", "cache-control": "no-store" });
      res.end(type === "text/html" ? addSnippet(body.toString("utf8"), path, snippet) : body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { docs: { type: "string", default: DEFAULT_DOCS } } });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let project = (await pool.query("select id, key, domains from projects where name = $1", [LOCAL_PROJECT])).rows[0];
  project ??= await createProject(pool, LOCAL_PROJECT, ["notchlight.com", "localhost"], "Europe/Helsinki");
  // Pages served from localhost may report to this project.
  await pool.query("update projects set domains = array(select distinct unnest(domains || '{localhost}')) where id = $1", [project.id]);
  await pool.end();
  const ingest = process.env.PUBLIC_URL ?? "http://localhost:8787";
  // data-local: the script skips localhost unless told otherwise.
  const snippet = `<script defer data-local data-project="${project.key}" src="${ingest}/s.js"></script>`;
  const port = Number(process.env.SITE_PORT ?? 8790);
  serveDocs(values.docs!, snippet).listen(port, "127.0.0.1", () => console.log(`Notchlight's website with Waymark on http://localhost:${port} (project ${project.key})`));
}
