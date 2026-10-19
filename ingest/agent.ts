// Browser, OS and device type from the user agent and the window width. Only the family is kept, never versions.

const BOT =
  /bot\b|bot\/|crawl|spider|slurp|scrape|headless|lighthouse|pagespeed|pingdom|uptime|monitor|preview|curl|wget|python|java\/|okhttp|go-http|axios|node-fetch|undici|httpclient|facebookexternalhit|embedly|whatsapp|telegram|phantom|selenium|puppeteer|playwright/i;

export function isBot(ua: string): boolean {
  return ua.length < 20 || BOT.test(ua);
}

const BROWSERS: [RegExp, string][] = [
  [/FBAN|FBAV/, "Facebook"],
  [/Instagram/, "Instagram"],
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser/, "Samsung Internet"],
  [/YaBrowser/, "Yandex"],
  [/Vivaldi/, "Vivaldi"],
  [/DuckDuckGo|Ddg\//, "DuckDuckGo"],
  [/Firefox\/|FxiOS/, "Firefox"],
  [/Chrome\/|CriOS/, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPod/, "iOS"],
  [/iPad/, "iPadOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Macintosh|Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];

const match = (list: [RegExp, string][], ua: string) => list.find(([re]) => re.test(ua))?.[1] ?? "Other";

// Device by window width, the same breakpoints Plausible uses; the user agent decides when the width is missing.
export function deviceOf(ua: string, width: number | null): string {
  if (width) return width < 576 ? "Mobile" : width < 992 ? "Tablet" : width < 1440 ? "Laptop" : "Desktop";
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return "Tablet";
  if (/Mobi|iPhone|Android/.test(ua)) return "Mobile";
  return "Desktop";
}

export function agentOf(ua: string, width: number | null) {
  return { browser: match(BROWSERS, ua), os: match(SYSTEMS, ua), device: deviceOf(ua, width) };
}
