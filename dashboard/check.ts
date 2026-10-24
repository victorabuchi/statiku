// Fetching from people's websites: "Check installation" looks for a site's snippet on its home page, and site icons
// come from the icon the page names. The address comes from a user, so every connection, redirects included, is
// refused unless it resolves to a public address: nothing on this machine, Render's private network or a cloud
// metadata service can be reached this way.
import { lookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net, bits, "ipv4");
// IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) are caught by the IPv4 rules above.
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) {
  PRIVATE.addSubnet(net, bits, "ipv6");
}

export const isPublicAddress = (address: string) => {
  const family = isIP(address);
  return family !== 0 && !PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
};

// DNS lookups that fail for private addresses, so a name can't point the fetch inward (or switch to inward later).
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const allowed = addresses.filter((a) => isPublicAddress(a.address));
    if (!allowed.length) return callback(Object.assign(new Error(`${hostname} is not a public address`), { code: "EPRIVATE" }), "", 0);
    if (options.all) return (callback as unknown as (e: null, a: typeof allowed) => void)(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
};

type Fetched = { status: number; url: URL; type: string; body: Buffer };

function get(url: URL, maxBytes: number, accept: string): Promise<Fetched & { location?: string }> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, {
      lookup: publicLookup,
      timeout: 8000,
      headers: { "user-agent": "Mozilla/5.0 (compatible; StatikuCheck/1.0)", accept },
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ status, url, type, body: Buffer.alloc(0), location: res.headers.location });
      }
      let size = 0;
      const chunks: Buffer[] = [];
      const done = () => resolve({ status, url, type, body: Buffer.concat(chunks) });
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) return req.destroy();
        chunks.push(chunk);
      });
      res.on("end", done);
      res.on("close", done);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

// A GET that follows up to four redirects, each checked like the first. A body past maxBytes is cut short.
export async function fetchPublic(start: URL, { maxBytes = 2_000_000, accept = "text/html" } = {}): Promise<Fetched> {
  let url = start;
  for (let hops = 0; ; hops++) {
    if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error("redirected away from the web"), { code: "EPROTO" });
    const res = await get(url, maxBytes, accept);
    if (!res.location || hops >= 4) return { status: res.status, url, type: res.type, body: res.body };
    url = new URL(res.location, url);
  }
}

export type CheckResult = { found: boolean; url: string; message: string; otherKey?: string };

export async function checkInstall(domain: string, key: string): Promise<CheckResult> {
  try {
    const res = await fetchPublic(new URL(`https://${domain}/`));
    const host = res.url.host;
    if (res.status >= 400) {
      return { found: false, url: res.url.href, message: `${host} answered with an error (${res.status}), so its page couldn't be read.` };
    }
    const html = res.body.toString("utf8");
    if (html.includes(key)) return { found: true, url: res.url.href, message: `The tracking code is on ${host}.` };
    const other = html.match(/data-project="(p_[a-z0-9]+)"/)?.[1];
    if (other) {
      return {
        found: false, url: res.url.href, otherKey: other,
        message: `${host} has a Statiku code for another site (${other}). Replace it with this site's code.`,
      };
    }
    return {
      found: false, url: res.url.href,
      message: `The tracking code isn't on ${host}'s home page yet. If you added it with Google Tag Manager, it won't show in the page itself: open your site, and the status above turns green when the first visit arrives.`,
    };
  } catch (e) {
    const code = (e as { code?: string }).code;
    const why = code === "ENOTFOUND" ? `${domain} couldn't be found. Check the address in Settings.`
      : code === "EPRIVATE" ? `${domain} doesn't point to a public website.`
      : code === "ETIMEDOUT" ? `${domain} took too long to answer.`
      : `${domain} couldn't be reached (${code ?? (e as Error).message}).`;
    return { found: false, url: `https://${domain}/`, message: `${why} You can still open your site: the status above turns green when the first visit arrives.` };
  }
}

// What an image really is, from its first bytes; the type a server claims isn't trusted.
export function imageType(body: Buffer): string | null {
  if (body.length < 4) return null;
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (body[0] === 0 && body[1] === 0 && body[2] === 1 && body[3] === 0) return "image/x-icon";
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(body.subarray(0, 1024).toString("utf8"))) return "image/svg+xml";
  return null;
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((v) => v !== undefined);

// A site's icon: the one its home page names (an Apple touch icon or a large one first), or /favicon.ico.
export async function fetchIcon(domain: string): Promise<{ data: Buffer; type: string } | null> {
  const candidates: { url: URL; score: number }[] = [];
  try {
    const page = await fetchPublic(new URL(`https://${domain}/`), { maxBytes: 800_000 });
    if (page.status < 400) {
      for (const tag of page.body.toString("utf8").match(/<link\b[^>]*>/gi) ?? []) {
        const rel = (attr(tag, "rel") ?? "").toLowerCase();
        const href = attr(tag, "href");
        if (!href || !/(^|\s)(icon|shortcut icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(rel)) continue;
        const size = parseInt(attr(tag, "sizes") ?? "", 10) || (rel.includes("apple-touch-icon") ? 180 : 32);
        const svg = /\.svg(\?|#|$)/i.test(href) || attr(tag, "type") === "image/svg+xml";
        try {
          candidates.push({ url: new URL(href, page.url), score: svg ? 300 : size >= 48 ? 100 + Math.min(size, 256) : size });
        } catch {}
      }
    }
  } catch {}
  candidates.sort((a, b) => b.score - a.score);
  candidates.push({ url: new URL(`https://${domain}/favicon.ico`), score: 0 });
  for (const { url } of candidates.slice(0, 4)) {
    try {
      const res = await fetchPublic(url, { maxBytes: 200_000, accept: "image/*" });
      const type = res.status < 400 && res.body.length < 200_000 ? imageType(res.body) : null;
      if (type) return { data: res.body, type };
    } catch {}
  }
  return null;
}
