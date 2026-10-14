/**
 * Serves the React app built from `ui/` into `dist/ui/`: hashed assets under
 * `/_ui/`, and `index.html` with a bootstrap that tells the app which party's
 * pages it is on.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("./ui/", import.meta.url));
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

let index: string | undefined;

export interface Boot {
  role: string;
  origins: Record<string, string>;
  notice: string;
  candidate: { name: string; email: string };
}

export function uiPage(boot: Boot): Response {
  if (index === undefined && existsSync(join(DIR, "index.html")))
    index = readFileSync(join(DIR, "index.html"), "utf8");
  if (index === undefined)
    return new Response(
      "<!doctype html><p>The sandbox UI isn't built. Run <code>pnpm --filter @ojcp/sandbox build</code>.</p>",
      { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  // JSON is data, not markup: escape "<" so nothing in it can close the script element.
  const json = JSON.stringify(boot).replace(/</g, "\\u003c");
  return new Response(
    index.replace("<!--sandbox-boot-->", `<script>window.__SANDBOX__=${json}</script>`),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export function uiAsset(pathname: string): Response {
  const file = normalize(join(DIR, pathname.slice("/_ui/".length)));
  if (!file.startsWith(DIR.endsWith(sep) ? DIR : DIR + sep) || !existsSync(file))
    return new Response("Not found", { status: 404 });
  return new Response(readFileSync(file), {
    headers: {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
