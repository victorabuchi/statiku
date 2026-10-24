// "Check installation": fetches a site's home page and looks for its Statiku snippet. The address comes from a user,
// so every connection, redirects included, is refused unless it resolves to a public address: nothing on this
// machine, Render's private network or a cloud metadata service can be reached this way.
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

// DNS lookups that fail for private addresses, so a name can't point the check inward (or switch to inward later).
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const allowed = addresses.filter((a) => isPublicAddress(a.address));
    if (!allowed.length) return callback(Object.assign(new Error(`${hostname} is not a public address`), { code: "EPRIVATE" }), "", 0);
    if (options.all) return (callback as unknown as (e: null, a: typeof allowed) => void)(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
};

const MAX_BYTES = 2_000_000;

function get(url: URL): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, {
      lookup: publicLookup,
      timeout: 8000,
      headers: { "user-agent": "Mozilla/5.0 (compatible; StatikuCheck/1.0)", accept: "text/html" },
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ status, location: res.headers.location, body: "" });
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) return req.destroy();
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("close", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

export type CheckResult = { found: boolean; url: string; message: string; otherKey?: string };

export async function checkInstall(domain: string, key: string): Promise<CheckResult> {
  let url = new URL(`https://${domain}/`);
  try {
    for (let hops = 0; ; hops++) {
      if (!/^https?:$/.test(url.protocol)) throw new Error("redirected away from the web");
      const res = await get(url);
      if (res.location && hops < 4) {
        url = new URL(res.location, url);
        continue;
      }
      if (res.status >= 400) {
        return { found: false, url: url.href, message: `${url.host} answered with an error (${res.status}), so its page couldn't be read.` };
      }
      if (res.body.includes(key)) return { found: true, url: url.href, message: `The tracking code is on ${url.host}.` };
      const other = res.body.match(/data-project="(p_[a-z0-9]+)"/)?.[1];
      if (other) {
        return {
          found: false, url: url.href, otherKey: other,
          message: `${url.host} has a Statiku code for another site (${other}). Replace it with this site's code.`,
        };
      }
      return {
        found: false, url: url.href,
        message: `The tracking code isn't on ${url.host}'s home page yet. If you added it with Google Tag Manager, it won't show in the page itself: open your site, and the status above turns green when the first visit arrives.`,
      };
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    const why = code === "ENOTFOUND" ? `${domain} couldn't be found. Check the address in Settings.`
      : code === "EPRIVATE" ? `${domain} doesn't point to a public website.`
      : code === "ETIMEDOUT" ? `${domain} took too long to answer.`
      : `${domain} couldn't be reached (${code ?? (e as Error).message}).`;
    return { found: false, url: url.href, message: `${why} You can still open your site: the status above turns green when the first visit arrives.` };
  }
}
