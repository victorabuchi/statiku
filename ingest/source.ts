// Where a visit came from: its campaign tags first, then the referrer, then Direct.

export type Source = {
  source: string;
  referrerHost: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
};

// Well-known referrers by hostname. More specific hosts come before the broad ones that would also match them.
const SITES: [RegExp, string][] = [
  [/^mail\.google\.com$/, "Gmail"],
  [/^gemini\.google\.com$/, "Gemini"],
  [/(^|\.)google\.[a-z.]+$/, "Google"],
  [/(^|\.)bing\.com$/, "Bing"],
  [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)yahoo\.com$/, "Yahoo"],
  [/(^|\.)yandex\.[a-z]+$/, "Yandex"],
  [/(^|\.)ecosia\.org$/, "Ecosia"],
  [/^search\.brave\.com$/, "Brave Search"],
  [/(^|\.)kagi\.com$/, "Kagi"],
  [/(^|\.)baidu\.com$/, "Baidu"],
  [/(^|\.)chatgpt\.com$|(^|\.)openai\.com$/, "ChatGPT"],
  [/(^|\.)perplexity\.ai$/, "Perplexity"],
  [/(^|\.)claude\.ai$/, "Claude"],
  [/^t\.co$|(^|\.)twitter\.com$|(^|\.)x\.com$/, "X"],
  [/(^|\.)facebook\.com$|^fb\.me$/, "Facebook"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)threads\.(net|com)$/, "Threads"],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "LinkedIn"],
  [/(^|\.)reddit\.com$|^redd\.it$/, "Reddit"],
  [/^news\.ycombinator\.com$/, "Hacker News"],
  [/(^|\.)producthunt\.com$/, "Product Hunt"],
  [/(^|\.)github\.com$/, "GitHub"],
  [/(^|\.)youtube\.com$|^youtu\.be$/, "YouTube"],
  [/(^|\.)bsky\.app$/, "Bluesky"],
  [/(^|\.)mastodon\.[a-z.]+$/, "Mastodon"],
  [/(^|\.)tiktok\.com$/, "TikTok"],
  [/(^|\.)pinterest\.[a-z.]+$/, "Pinterest"],
  [/^t\.me$|(^|\.)telegram\.(org|me)$/, "Telegram"],
  [/(^|\.)discord(app)?\.com$/, "Discord"],
  [/(^|\.)slack\.com$/, "Slack"],
  [/(^|\.)outlook\.(live|office)\.com$/, "Outlook"],
  [/(^|\.)macupdate\.com$/, "MacUpdate"],
  [/(^|\.)macnative\.io$/, "MacNative"],
];

// utm_source values people commonly write, mapped to the same names: "producthunt" → "Product Hunt".
const ALIASES = new Map<string, string>([
  ...SITES.map(([, name]): [string, string] => [name.toLowerCase().replace(/\s+/g, ""), name]),
  ["twitter", "X"],
  ["hn", "Hacker News"],
  ["fb", "Facebook"],
  ["ig", "Instagram"],
  ["yt", "YouTube"],
]);

const clip = (value: string | null, max = 100) => (value ? value.trim().slice(0, max) || null : null);
const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");

export function siteName(host: string): string {
  const h = bare(host);
  return SITES.find(([re]) => re.test(h))?.[1] ?? h;
}

function tagName(tag: string): string {
  const alias = ALIASES.get(tag.toLowerCase().replace(/\s+/g, ""));
  if (alias) return alias;
  // A domain written as the tag, such as utm_source=news.ycombinator.com.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(tag)) return siteName(tag);
  return tag;
}

export function sourceOf(page: URL, referrer: string | null): Source {
  const q = page.searchParams;
  let referrerHost: string | null = null;
  if (referrer) {
    try {
      const r = new URL(referrer);
      // Moving between pages of the same site is not a source.
      if (/^https?:$/.test(r.protocol) && bare(r.hostname) !== bare(page.hostname)) referrerHost = bare(r.hostname);
    } catch {}
  }
  const tag = clip(q.get("utm_source") ?? q.get("ref") ?? q.get("source") ?? q.get("via"));
  return {
    source: tag ? tagName(tag) : referrerHost ? siteName(referrerHost) : "Direct",
    referrerHost,
    utmMedium: clip(q.get("utm_medium")),
    utmCampaign: clip(q.get("utm_campaign")),
    utmContent: clip(q.get("utm_content")),
    utmTerm: clip(q.get("utm_term")),
  };
}
