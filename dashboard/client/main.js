// Statiku's dashboard: one page app. Signed out it shows sign-in, sign-up and invitations; signed in, the websites,
// and for each one its analytics, a live view with a globe, the steps to add it to the site, and its settings, plus
// the account's own settings and team. Everything shown comes from /api, and everything from the server goes into
// the page as text.
import {
  siCloudflare, siFathom, siFramer, siGithub, siGoogleanalytics, siGoogletagmanager, siMatomo, siPlausibleanalytics, siShopify, siSimpleanalytics,
  siSquarespace, siUmami, siWebflow, siWix, siWordpress,
} from "simple-icons";
import { lineChart, minuteBars, sparkline, svgEl } from "./charts.js";
import { createGlobe } from "./globe.js";

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
// Nothing (null, false) puts nothing on the page, as with h(): never the word "null".
const replaceChildren = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...kids) {
  return replaceChildren.apply(this, kids.flat().filter((k) => k != null && k !== false));
};

function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "style") Object.assign(node.style, v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "hidden" || k === "open") node[k] = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
  return node;
}

const ICONS = {
  // Two windows, one behind the other: every website at once. A filled shape from Material Symbols (Apache 2.0),
  // on its own grid.
  websites: { box: "0 -960 960 960", path: '<path d="M640-160v-360H160v360h480Zm80-200v-80h80v-360H320v200h-80v-200q0-33 23.5-56.5T320-880h480q33 0 56.5 23.5T880-800v360q0 33-23.5 56.5T800-360h-80ZM160-80q-33 0-56.5-23.5T80-160v-360q0-33 23.5-56.5T160-600h480q33 0 56.5 23.5T720-520v360q0 33-23.5 56.5T640-80H160Z"/>' },
  minus: '<path d="M4.5 10h11"/>',
  globe: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c1.9 2.1 2.9 4.4 2.9 7s-1 4.9-2.9 7c-1.9-2.1-2.9-4.4-2.9-7s1-4.9 2.9-7Z"/>',
  chart: '<path d="M4 16.5v-4M8 16.5v-8M12 16.5v-6M16 16.5V4"/>',
  live: '<circle cx="10" cy="10" r="1.8"/><path d="M6.8 13.2a4.5 4.5 0 0 1 0-6.4M13.2 6.8a4.5 4.5 0 0 1 0 6.4M4.3 15.7a8 8 0 0 1 0-11.4M15.7 4.3a8 8 0 0 1 0 11.4"/>',
  code: '<path d="m7 6-4 4 4 4M13 6l4 4-4 4"/>',
  // A flame: heatmaps.
  heat: '<path d="M10 17c3 0 5-2.1 5-5 0-3.4-2.6-5.2-3.4-8.5-1.7 1.1-2.6 2.7-2.6 4.6-.8-.6-1.4-1.5-1.6-2.6C5.9 7.2 5 9.3 5 12c0 2.9 2 5 5 5Z"/><path d="M10 17c-1.3 0-2.2-1-2.2-2.3 0-1.5 1.2-2.2 2.2-3.7 1 1.5 2.2 2.2 2.2 3.7 0 1.3-.9 2.3-2.2 2.3Z"/>',
  // A plaster: injuries.
  injury: '<rect x="2.6" y="7.2" width="14.8" height="5.6" rx="2.8" transform="rotate(-40 10 10)"/><path d="M8.6 9.2h.01M11.4 9.2h.01M8.6 10.8h.01M11.4 10.8h.01" stroke-width="2"/>',
  // A football: the match view.
  ball: '<circle cx="10" cy="10" r="7"/><path d="m10 7 2.9 2.1-1.1 3.4H8.2L7.1 9.1Z"/><path d="M10 3v4M12.9 9.1l3.6-1.3M11.8 12.5l2.3 3.1M8.2 12.5l-2.3 3.1M7.1 9.1 3.5 7.8"/>',
  // A pulse: a tracker, anything a site sends.
  track: '<path d="M2.5 10.5h3.2l2-5.2 3.4 9.4 2.1-5.6h4.3"/>',
  // A number sign.
  hash: '<path d="M8 3.5 6.5 16.5M13.5 3.5 12 16.5M4 7.5h12.5M3.5 12.5H16"/>',
  // A cog (after Feather's, MIT), drawn on a 24 grid and scaled to this one.
  settings: '<g transform="scale(0.8333)" stroke-width="1.9"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></g>',
  person: '<circle cx="10" cy="7.3" r="3.1"/><path d="M4.2 16.6c.9-2.9 3.1-4.4 5.8-4.4s4.9 1.5 5.8 4.4"/>',
  team: '<circle cx="7.5" cy="7.5" r="2.6"/><path d="M2.8 15.8c.7-2.4 2.5-3.7 4.7-3.7s4 1.3 4.7 3.7"/><circle cx="14" cy="6.8" r="2.1"/><path d="M13.6 11.6c1.8 0 3.1 1 3.7 3"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  down: '<path d="m6 8 4 4 4-4"/>',
  calendar: '<rect x="3.5" y="4.5" width="13" height="12" rx="2"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/>',
  close: '<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>',
  menu: '<path d="M3.5 6h13M3.5 10h13M3.5 14h13"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  back: '<path d="M12 15 7 10l5-5"/>',
  copy: '<rect x="7" y="7" width="9.5" height="9.5" rx="2"/><path d="M13 7V5.5A2 2 0 0 0 11 3.5H5.5a2 2 0 0 0-2 2V11a2 2 0 0 0 2 2H7"/>',
  external: '<path d="M11.5 3.5h5v5M16.5 3.5 9 11M14 12v3.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H8"/>',
  mail: '<rect x="3" y="5" width="14" height="10.5" rx="2"/><path d="m3.5 6 6.5 5 6.5-5"/>',
  wait: '<circle cx="10" cy="10" r="7"/><path d="M10 6.3V10l2.5 1.8"/>',
  eye: '<path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z"/><circle cx="10" cy="10" r="2.2"/>',
  eyeOff: '<path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z"/><circle cx="10" cy="10" r="2.2"/><path d="M3.5 3.5l13 13"/>',
  download: '<path d="M10 3.5v9M6.3 9l3.7 3.7L13.7 9M4 16.5h12"/>',
  export: '<path d="M10 12.5v-9M6.3 7.2 10 3.5l3.7 3.7M4 12v3.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V12"/>',
  cart: '<path d="M3 4h2l1.6 8.2a1 1 0 0 0 1 .8h6.6a1 1 0 0 0 1-.8L16.5 7H6"/><circle cx="8.5" cy="16" r="1"/><circle cx="14" cy="16" r="1"/>',
  spark: '<path d="M10 3.5v3M10 13.5v3M3.5 10h3M13.5 10h3M5.4 5.4l2.1 2.1M12.5 12.5l2.1 2.1M5.4 14.6l2.1-2.1M12.5 7.5l2.1-2.1"/>',
  app: '<rect x="3" y="4" width="14" height="10" rx="1.8"/><path d="M7.5 16.5h5M10 14v2.5"/>',
  logout: '<path d="M8 16.5H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h3M12.5 13.5 16 10l-3.5-3.5M16 10H8"/>',
  trash: '<path d="M4 6h12M8 6V4.5h4V6M5.5 6l.7 10a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-10"/>',
  // A clock turning back: history from before.
  history: '<path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6L3.5 7.3"/><path d="M3.5 3.8v3.5H7M10 6.5V10l2.4 1.6"/>',
  // Three rounded bars, short, tall and medium: the plans' tiers (the idea of Onshipy's plan icon, drawn for Statiku).
  plan: '<rect x="3.4" y="9.6" width="3.2" height="7" rx="1.6"/><rect x="8.4" y="3.4" width="3.2" height="13.2" rx="1.6"/><rect x="13.4" y="6.6" width="3.2" height="10" rx="1.6"/>',
  file: '<path d="M11.5 3H6a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 6 17h8a1.5 1.5 0 0 0 1.5-1.5V7Z"/><path d="M11.5 3v4h4M7.5 11h5M7.5 14h3"/>',
};
function icon(name, size = 18) {
  const t = document.createElement("template"), shape = ICONS[name];
  t.innerHTML = typeof shape === "string"
    ? `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`
    : `<svg width="${size}" height="${size}" viewBox="${shape.box}" fill="currentColor" aria-hidden="true">${shape.path}</svg>`;
  return t.content.firstChild;
}

// A password (or a key) with a button inside the field that shows what's typed, and hides it again.
function revealable(input, what = "password") {
  const button = h("button", { class: "reveal", type: "button", "aria-label": `Show ${what}`, "aria-pressed": "false" }, icon("eye"));
  button.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-label", `${show ? "Hide" : "Show"} ${what}`);
    button.setAttribute("aria-pressed", String(show));
    button.replaceChildren(icon(show ? "eyeOff" : "eye"));
    input.focus();
  });
  return h("div", { class: "secret" }, input, button);
}

// The logo at the versioned address the page's own icon link carries, so a new logo shows at once.
const LOGO = document.querySelector('link[rel="icon"]')?.getAttribute("href") ?? "/favicon.svg";

const int = (n) => Math.round(n ?? 0).toLocaleString("en-US");
const compact = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "K" : String(Math.round(n * 10) / 10));
const pct = (a, b, d = 1) => (b ? ((100 * a) / b).toFixed(d) + "%" : "–");
const duration = (s) => (s == null ? "–" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
let countryName = (c) => c;
try {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  countryName = (c) => (c && c !== "Unknown" ? names.of(c) ?? c : "Unknown");
} catch {}
const flag = (c) => (/^[A-Z]{2}$/.test(c ?? "") ? String.fromCodePoint(...[...c].map((ch) => 127397 + ch.charCodeAt(0))) : "🏳️");
function ago(at) {
  if (!at) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(at)) / 1000));
  return s < 10 ? "just now" : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
}
const clock = (d = new Date()) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const day = (d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });

// A site's first letter on a colour of its own, while it has no icon of its own.
const LETTERS = ["#2a78d6", "#008060", "#6250d6", "#eb6834", "#d55181", "#1baf7a", "#c98500", "#e34948"];
function letter(site, size = 32) {
  const name = site.name || site.domains?.[0] || "?";
  let hash = 0;
  for (const ch of site.domains?.[0] ?? name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return h("span", { class: "letter", style: { background: LETTERS[hash % LETTERS.length], width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.44)}px`, borderRadius: `${Math.round(size / 4)}px` }, "aria-hidden": "true", text: name.trim()[0]?.toUpperCase() ?? "?" });
}
// The site's own icon, fetched from the site by Statiku's server; its letter when it has none.
function siteIcon(site, size = 32) {
  if (site.icon === false) return letter(site, size);
  const img = h("img", { class: "site-icon", src: `/api/sites/${site.key}/icon?v=${site.icon ?? 0}`, alt: "", width: size, height: size, style: { width: `${size}px`, height: `${size}px`, borderRadius: `${Math.round(size / 4)}px`, padding: size > 24 ? "3px" : "1px" } });
  img.addEventListener("error", () => img.replaceWith(letter(site, size)), { once: true });
  return img;
}
// A person's photo, or an empty silhouette.
// A person's photo, or until they add one their initials on a colour of their own (the same every time).
function photo(user, size = 32) {
  const box = h("span", { class: "photo", style: { width: `${size}px`, height: `${size}px` } });
  const initials = (user?.name || user?.email || "").split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  if (user?.photo) box.append(h("img", { src: `/api/me/photo?v=${user.photo}`, alt: "" }));
  else if (initials) {
    let hue = 0;
    for (const c of user.name || user.email) hue = (hue * 31 + c.charCodeAt(0)) % 360;
    box.classList.add("initials");
    Object.assign(box.style, { background: `hsl(${hue} 55% 90%)`, color: `hsl(${hue} 45% 28%)`, fontSize: `${Math.round(size * 0.4)}px` });
    box.append(initials);
  } else box.append(icon("person", Math.round(size * 0.62)));
  return box;
}
// `text` with code spans: "Paste it before `</head>`."
const rich = (text) => text.split("`").map((part, i) => (i % 2 ? h("code", { text: part }) : part));

function toast(message) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status", text: message });
  document.body.append(t);
  setTimeout(() => t.remove(), 2800);
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
    if (button) {
      const before = [...button.childNodes];
      button.replaceChildren(icon("check", 14), "Copied");
      setTimeout(() => button.replaceChildren(...before), 1600);
    }
  } catch {
    toast("Couldn't copy. Select the text and copy it yourself.");
  }
}

// A confirmation over the page. With `typed`, the person types that text before confirming.
function confirmDialog({ title, body, confirm, danger = false, typed = null }) {
  return new Promise((resolve) => {
    const input = typed ? h("input", { class: "input", placeholder: typed, "aria-label": `Type ${typed} to confirm`, autocomplete: "off", spellcheck: "false" }) : null;
    const yes = h("button", { class: `btn ${danger ? "critical" : "primary"}`, type: "button", text: confirm, disabled: !!typed });
    const close = (answer) => {
      back.remove();
      document.removeEventListener("keydown", onKey);
      resolve(answer);
    };
    const onKey = (e) => e.key === "Escape" && close(false);
    input?.addEventListener("input", () => (yes.disabled = input.value.trim().toLowerCase() !== typed.toLowerCase()));
    yes.addEventListener("click", () => close(true));
    const back = h("div", { class: "dialog-back", onclick: (e) => e.target === back && close(false) },
      h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("div", { class: "head" }, h("h2", { text: title })),
        h("div", { class: "body" }, h("p", { text: body }), typed ? h("label", { class: "field" }, h("span", {}, "Type ", h("b", { text: typed }), " to confirm"), input) : null),
        h("div", { class: "foot" }, h("button", { class: "btn", type: "button", text: "Cancel", onclick: () => close(false) }), yes)));
    document.addEventListener("keydown", onKey);
    document.body.append(back);
    (input ?? yes).focus();
  });
}

function download(name, text, type = "text/csv") {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  });
}
// A spreadsheet cell. Text that a spreadsheet would run as a formula (a page path such as "=HYPERLINK(…)") is quoted.
function cell(value) {
  let s = value == null ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- Server ----------
class SignedOut extends Error {}
// A report closed because the trial ended unpaid.
class Locked extends Error {}
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !/^\/api\/(login|me\/password|me$)/.test(path)) {
    state.user = null;
    go(`/login?next=${encodeURIComponent(location.pathname)}`, true);
    throw new SignedOut();
  }
  if (res.status === 402) throw new Locked(data.error);
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

// ---------- State and navigation ----------
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("statiku") || "{}");
  } catch {
    return {};
  }
})();
const NO_FILTERS = { source: null, country: null, device: null, browser: null, os: null, page: null };
const state = {
  user: undefined, sites: null, range: saved.range ?? "d30", from: saved.from ?? null, to: saved.to ?? null,
  metric: "visitors", appMetric: "installs", filters: { ...NO_FILTERS }, pagesTab: "top", table: false, by: null,
};
const remember = () => {
  try {
    localStorage.setItem("statiku", JSON.stringify({ range: state.range, from: state.from, to: state.to }));
  } catch {}
};

let leaving = [];
const onLeave = (fn) => leaving.push(fn);
function every(ms, fn) {
  const timer = setInterval(() => document.hidden || fn(), ms);
  onLeave(() => clearInterval(timer));
}

function go(path, replace = false) {
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  render();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href]");
  if (!a || a.target || a.hasAttribute("data-external") || a.hasAttribute("download") || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(a.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.preventDefault();
  go(url.pathname + url.search + url.hash);
});
window.addEventListener("popstate", () => render());

async function loadSites(fresh = false) {
  if (!state.sites || fresh) state.sites = (await api("/api/sites")).sites;
  return state.sites;
}

// ---------- Popovers ----------
let popover = null;
function closePopover() {
  popover?.node.remove();
  popover?.anchor.setAttribute("aria-expanded", "false");
  popover = null;
}
function openPopover(anchor, items, { align = "left", width } = {}) {
  if (popover?.anchor === anchor) return closePopover();
  closePopover();
  const node = h("div", { class: "popover", role: "menu" }, items);
  document.body.append(node);
  const r = anchor.getBoundingClientRect();
  const w = width ?? Math.max(240, r.width);
  node.style.width = `${Math.min(w, innerWidth - 24)}px`;
  node.style.top = `${r.bottom + 6}px`;
  node.style.left = `${Math.max(12, Math.min(align === "right" ? r.right - w : r.left, innerWidth - w - 12))}px`;
  anchor.setAttribute("aria-expanded", "true");
  popover = { node, anchor };
  node.querySelector("button, a, input")?.focus();
}
document.addEventListener("pointerdown", (e) => {
  if (popover && !popover.node.contains(e.target) && !popover.anchor.contains(e.target)) closePopover();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && popover) {
    const anchor = popover.anchor;
    closePopover();
    anchor.focus();
  }
});
const menuItem = (content, onclick, extra = {}) =>
  h("button", { class: "item", type: "button", role: "menuitem", onclick: () => { closePopover(); onclick(); }, ...extra }, content);

// ---------- Shell ----------
function shell(site, active, content) {
  const sidebar = h("aside", { class: "sidebar", id: "sidebar" });
  const overlay = h("div", { class: "overlay", onclick: () => toggleMenu(false) });
  const toggleMenu = (open) => {
    sidebar.classList.toggle("open", open);
    overlay.classList.toggle("open", open);
  };
  const navItem = (href, iconName, label, current, extra) =>
    h("a", { class: "nav-item", href, "aria-current": current ? "page" : null, onclick: () => toggleMenu(false) }, icon(iconName), label, extra);

  const switcher = h("button", {
    class: "switcher", type: "button", "aria-haspopup": "menu", "aria-expanded": "false",
    onclick: () => openPopover(switcher, [
      ...state.sites.map((s) => h("a", { class: "item", href: `/sites/${s.key}`, role: "menuitemradio", "aria-checked": String(s.key === site?.key), onclick: closePopover },
        siteIcon(s, 22), h("span", {}, h("span", { text: s.name })), s.live ? h("span", { class: "end live-pill" }, h("i", { class: "dot pulse" }), s.live) : null)),
      state.sites.length ? h("hr") : null,
      h("a", { class: "item", href: "/", onclick: closePopover }, icon("websites"), "All websites"),
      h("a", { class: "item", href: "/sites/new", onclick: closePopover }, icon("plus"), "Add website"),
    ]),
  }, site ? siteIcon(site, 22) : icon("websites"), h("span", { class: "site-name", text: site ? site.name : "All websites" }),
    site && site.name !== site.domains[0] ? h("span", { class: "site-domain", text: site.domains[0] }) : null, icon("down", 16));

  const avatar = h("button", {
    class: "avatar", type: "button", "aria-label": `Account: ${state.user.name}`, "aria-haspopup": "menu", "aria-expanded": "false",
    onclick: () => openPopover(avatar, [
      h("div", { class: "who" }, photo(state.user, 36), h("div", {}, h("b", { text: state.user.name }), h("span", { class: "muted", text: state.user.email }))),
      h("a", { class: "item", href: "/settings", onclick: closePopover }, icon("settings"), "Account settings"),
      h("a", { class: "item", href: "/settings#team", onclick: closePopover }, icon("team"), "Team"),
      h("hr"),
      menuItem([icon("logout"), "Sign out"], async () => {
        await api("/api/logout", { method: "POST" }).catch(() => {});
        state.user = null;
        state.sites = null;
        go("/login", true);
      }),
    ], { align: "right", width: 280 }),
  }, photo(state.user, 30));

  const topbar = h("header", { class: "topbar" },
    h("button", { class: "menu-button", type: "button", "aria-label": "Menu", "aria-controls": "sidebar", onclick: () => toggleMenu(!sidebar.classList.contains("open")) }, icon("menu", 22)),
    h("a", { class: "brand", href: "/" }, h("img", { src: LOGO, alt: "" }), h("span", { text: "Statiku" })),
    h("div", { class: "center" }, switcher),
    h("div", { class: "actions" }, avatar));

  // Settings sits at the foot: a site's own inside a site, the account's everywhere else.
  sidebar.append(
    h("nav", { "aria-label": "Main" },
      navItem("/", "websites", "Websites", active === "home"),
      navItem("/sites/new", "plus", "Add website", active === "add"),
      navItem("/trackers", "track", "Trackers", active === "trackers"),
      navItem("/trackers/new", "plus", "Add tracker", active === "addTracker"),
      site ? [
        h("div", { class: "nav-label" }, siteIcon(site, 16), h("span", { text: site.domains[0] })),
        navItem(`/sites/${site.key}`, "chart", "Analytics", active === "analytics"),
        navItem(`/sites/${site.key}/live`, "live", "Live view", active === "live",
          h("span", { class: "count", id: "nav-live", hidden: !site.live }, h("i", { class: "dot pulse" }), h("span", { text: String(site.live) }))),
        navItem(`/sites/${site.key}/match`, "ball", "Match view", false),
        navItem(`/sites/${site.key}/heatmaps`, "heat", "Heatmaps", active === "heatmaps"),
        navItem(`/sites/${site.key}/setup`, "code", "Setup", active === "setup"),
        navItem(`/sites/${site.key}/import`, "history", "Import history", active === "import"),
      ] : null),
    h("div", { class: "foot" }, navItem("/plan", "plan", "Plan", active === "plan"), site
      ? navItem(`/sites/${site.key}/settings`, "settings", "Settings", active === "settings")
      : navItem("/settings", "settings", "Settings", active === "account")));

  return [topbar, sidebar, overlay, h("main", { class: "main", id: "main" }, content)];
}

function pageHead(titleParts, tools) {
  return h("div", { class: "page-head" }, h("div", { class: "title" }, titleParts), tools ? h("div", { class: "tools" }, tools) : null);
}
const failure = (e) => (e instanceof Locked ? lockedCard(e.message) : h("div", { class: "error", role: "alert", text: e.message || String(e) }));

// ---------- Your plan ----------
const daysLeft = (at) => Math.max(0, Math.ceil((new Date(at) - Date.now()) / 86400e3));
function lockedCard(message) {
  return h("div", { class: "card status-card" }, h("span", { class: "icon wait" }, icon("wait", 22)),
    h("div", { class: "what" }, h("b", { text: "These reports are closed for now" }), h("span", { class: "muted", text: message })),
    h("a", { class: "btn primary", href: "/plan" }, "Choose a plan"));
}
// A reminder above every page: the trial's last week, a closed account, or a month over the plan's events.
function billingBanner() {
  const b = state.billing;
  if (!b || b.access === "comp") return null;
  const text = b.access === "locked" ? "Your free trial has ended. Statiku is still counting your visitors: choose a plan to see them."
    : b.access === "trial" && daysLeft(b.trialEndsAt) <= 7 ? `Your free trial ends in ${daysLeft(b.trialEndsAt)} ${daysLeft(b.trialEndsAt) === 1 ? "day" : "days"}.`
    : b.over ? `Your sites sent ${int(b.usage)} events this month, more than the ${int(b.limit)} in your plan.`
    : null;
  return text ? h("div", { class: `banner${b.access === "locked" ? " bad" : ""}`, role: "status" }, h("span", { text }), h("a", { href: "/plan", text: b.over ? "Upgrade" : "Choose a plan" })) : null;
}

// The plan page: what the workspace pays for, what it used this month, and the plans to choose from.
async function planPage() {
  const b = await api("/api/billing");
  state.billing = b;
  // Back from Polar's checkout: the plan starts when Polar confirms the payment, usually within seconds.
  if (new URLSearchParams(location.search).get("billing") === "done") {
    toast("Thank you! Your plan starts as soon as Polar confirms the payment.");
    history.replaceState({}, "", "/plan");
    setTimeout(() => location.pathname === "/plan" && render(), 4000);
  }
  const date = (at, year = false) => new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric", ...(year ? { year: "numeric" } : {}) });
  const paying = b.access === "paid" && b.customer;
  const name = b.access === "comp" ? "Unlimited" : b.access === "trial" ? "Free trial" : b.access === "locked" ? "No plan" : b.planName;
  const status = b.access === "comp" ? "Statiku is free for this account, with no limit on events."
    : b.access === "trial" ? `${daysLeft(b.trialEndsAt)} days left, until ${date(b.trialEndsAt)}. Every feature, no card needed.`
    : b.access === "paid" ? `${b.status && b.status !== "active" ? `${b.status.replace("_", " ")}. ` : ""}${b.cancelAtPeriodEnd || b.status === "canceled" ? "Ends" : "Renews"} ${b.periodEnd ? date(b.periodEnd, true) : ""}.`
    : "Your free trial has ended. Statiku is still counting your visitors: choose a plan to see them.";
  const portal = async (button) => {
    button.disabled = true;
    try {
      location.href = (await api("/api/billing/portal", { method: "POST" })).url;
    } catch (err) {
      toast(err.message);
      button.disabled = false;
    }
  };
  const manage = paying ? h("button", { class: "btn", type: "button", text: "Invoices, card and cancelling", onclick: (e) => portal(e.currentTarget) }) : null;
  const used = b.limit ? Math.min(100, (100 * b.usage) / b.limit) : null;
  const summary = h("div", { class: "card plan-summary" },
    h("div", { class: "what" }, h("span", { class: "label", text: "Your plan" }), h("b", { text: name }), h("span", { class: "muted", text: status })),
    h("div", { class: "usage" }, h("span", { class: "label", text: "This month" }),
      h("b", { text: `${int(b.usage)} events` }),
      used === null ? h("span", { class: "muted", text: b.access === "comp" ? "No limit" : "Plans start at 10,000 a month" })
        : [h("div", { class: "meter-bar" }, h("i", { class: b.over ? "over" : "", style: { width: `${used}%` } })), h("span", { class: "muted", text: `${int(b.usage)} of ${int(b.limit)}${b.over ? ": over your plan" : ""}` })]),
    manage);

  let interval = "month";
  const plans = h("div", { class: "plans" });
  const drawPlans = () => plans.replaceChildren(...b.plans.map((p) => {
    const current = b.plan === p.id && b.access === "paid";
    const buyable = b.buyable.includes(`${p.id}:${interval}`);
    // Someone already paying changes plan in Polar's portal, so they never end up with two subscriptions.
    const label = b.access === "comp" ? "Included in Unlimited" : current ? "Your plan" : paying ? `Switch to ${p.name}` : buyable ? `Choose ${p.name}` : "Not on sale yet";
    const choose = h("button", {
      class: `btn${current || b.access === "comp" ? "" : " primary"}`, type: "button", text: label,
      disabled: current || b.access === "comp" || (!paying && !buyable),
      onclick: async () => {
        if (paying) return portal(choose);
        choose.disabled = true;
        try {
          location.href = (await api("/api/billing/checkout", { method: "POST", body: { plan: p.id, interval } })).url;
        } catch (err) {
          toast(err.message);
          choose.disabled = false;
        }
      },
    });
    return h("div", { class: `plan${current ? " current" : ""}` }, h("b", { text: p.name }),
      h("div", { class: "price" }, h("span", { text: `€${interval === "year" ? p.year : p.month}` }), h("small", { text: interval === "year" ? "a year" : "a month" })),
      h("span", { class: "muted", text: `Up to ${int(p.events)} events a month` }), choose);
  }));
  drawPlans();
  const periods = h("div");
  const drawPeriods = () => periods.replaceChildren(tabs([["month", "Monthly"], ["year", "Yearly, 2 months free"]], interval, (id) => {
    interval = id;
    drawPeriods();
    drawPlans();
  }));
  drawPeriods();
  const INCLUDED = ["The live globe and live view", "Every report, filter and export", "Imports from Google Analytics, Plausible, GitHub and files",
    "Alerts when a site goes quiet or gets a rush", "The app SDK for Mac and iOS", "Up to 50 websites, and your whole team", "Data kept in the EU"];

  return h("div", { class: "page narrow" },
    pageHead([icon("plan", 20), h("h1", { text: "Plan" }), h("span", { class: "muted", text: b.workspace })]),
    h("div", { class: "stack" }, summary,
    card("Plans", h("div", { class: "form" }, periods, plans,
      h("p", { class: "help", text: "Every plan has every feature; they differ only in how many events your sites and apps send in a month. An event is a page view or anything else they send. Prices in euros; VAT is added where it applies. Payments by Polar." })),
      { sub: "Choose by events a month" }),
    card("Every plan includes", h("ul", { class: "included" }, INCLUDED.map((x) => h("li", {}, icon("check", 16), x))))));
}
function card(title, body, { sub, end, id } = {}) {
  return h("div", { class: "card", id }, h("div", { class: "card-head" }, h("h2", { text: title }), sub ? h("span", { class: "sub", text: sub }) : null, end ? h("div", { class: "end" }, end) : null),
    h("div", { class: "card-body" }, body));
}

// ---------- Sign in, sign up, invitations ----------
function authForm(mode, { invite = null, onDone } = {}) {
  const signup = mode === "signup";
  const error = h("div", { class: "error", role: "alert", hidden: true });
  const field = (label, name, type, autocomplete, help) => {
    const id = `f-${name}`;
    const input = h("input", { class: "input big", id, name, type, autocomplete, required: true });
    return h("div", { class: "field" }, h("label", { for: id, text: label }),
      type === "password" ? revealable(input) : input,
      help ? h("span", { class: "help", text: help }) : null);
  };
  const button = h("button", { class: "btn primary big", type: "submit", text: signup ? (invite ? "Create account and join" : "Create account") : "Sign in" });
  const form = h("form", {
    class: "form", novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      const data = { ...Object.fromEntries(new FormData(form)), ...(invite ? { invite } : {}) };
      button.disabled = true;
      error.hidden = true;
      try {
        const { user } = await api(signup ? "/api/signup" : "/api/login", { method: "POST", body: data });
        state.user = user;
        state.sites = null;
        onDone(user);
      } catch (err) {
        if (err instanceof SignedOut) return;
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
      }
    },
  }, error,
    signup ? field("Your name", "name", "text", "name") : null,
    field("Email", "email", "email", "email"),
    field("Password", "password", "password", signup ? "new-password" : "current-password", signup ? "At least 8 characters." : null),
    button);
  setTimeout(() => form.querySelector("input")?.focus());
  return form;
}

function authLayout(...kids) {
  return h("div", { class: "auth" }, h("div", { class: "box" },
    // Back to the landing page, loaded whole: the server shows it to whoever isn't signed in.
    h("a", { class: "logo", href: "/", "data-external": true, "aria-label": "Statiku home" }, h("img", { src: LOGO, alt: "" }), h("span", { text: "Statiku" })), kids,
    h("p", { class: "promise" }, h("span", { text: "No cookies on your visitors" }), h("span", { text: "No IP addresses stored" }), h("span", { text: "Data kept in the EU" }))));
}

function authPage(mode) {
  const signup = mode === "signup";
  const next = new URLSearchParams(location.search).get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
  return authLayout(
    h("div", { class: "card" },
      h("div", {}, h("h1", { text: signup ? "Create your account" : "Sign in" }),
        h("p", { class: "sub", text: signup ? "Add your website and see your visitors in minutes. No credit card." : "See who's visiting your websites." })),
      authForm(mode, { onDone: () => go(safeNext ?? (signup ? "/sites/new" : "/"), true) }),
      signup ? null : h("p", { class: "forgot" }, h("a", { href: "/forgot", text: "Forgot your password?" }))),
    h("p", { class: "switch" }, signup ? "Already have an account? " : "New to Statiku? ",
      h("a", { href: `${signup ? "/login" : "/signup"}${safeNext ? `?next=${encodeURIComponent(safeNext)}` : ""}`, text: signup ? "Sign in" : "Create an account" })));
}

// A forgotten password: an email with a link, then a new password, which signs you in.
function forgotPage() {
  const error = h("div", { class: "error", role: "alert", hidden: true });
  const email = h("input", { class: "input big", id: "f-email", name: "email", type: "email", autocomplete: "email", required: true });
  const button = h("button", { class: "btn primary big", type: "submit", text: "Email me a link" });
  const box = h("div", { class: "card" },
    h("div", {}, h("h1", { text: "Forgot your password?" }), h("p", { class: "sub", text: "Enter your account's email and we'll send you a link to choose a new one." })),
    h("form", {
      class: "form", novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        error.hidden = true;
        try {
          await api("/api/password/forgot", { method: "POST", body: { email: email.value } });
          box.replaceChildren(h("div", {}, h("h1", { text: "Check your email" }),
            h("p", { class: "sub", text: `If there's an account for ${email.value.trim()}, a link to choose a new password is on its way. It works for an hour.` })),
            h("a", { class: "btn big", href: "/login", text: "Back to sign in" }));
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          button.disabled = false;
        }
      },
    }, error, h("div", { class: "field" }, h("label", { for: "f-email", text: "Email" }), email), button));
  setTimeout(() => email.focus());
  return authLayout(box, h("p", { class: "switch" }, "Remembered it? ", h("a", { href: "/login", text: "Sign in" })));
}

async function resetPage(token) {
  const info = await api(`/api/password/reset/${token}`);
  if (!info.valid) {
    return authLayout(h("div", { class: "card" }, h("div", {}, h("h1", { text: "This link doesn't work any more" }),
      h("p", { class: "sub", text: "Reset links work once, for an hour. Ask for a new one." })),
      h("a", { class: "btn primary big", href: "/forgot", text: "Send a new link" })));
  }
  const error = h("div", { class: "error", role: "alert", hidden: true });
  const password = h("input", { class: "input big", id: "f-password", name: "password", type: "password", autocomplete: "new-password", required: true });
  const button = h("button", { class: "btn primary big", type: "submit", text: "Save and sign in" });
  setTimeout(() => password.focus());
  return authLayout(h("div", { class: "card" },
    h("div", {}, h("h1", { text: "Choose a new password" }), h("p", { class: "sub", text: `For ${info.email}. You'll be signed out everywhere else.` })),
    h("form", {
      class: "form", novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        error.hidden = true;
        try {
          const { user } = await api(`/api/password/reset/${token}`, { method: "POST", body: { password: password.value } });
          state.user = user;
          state.sites = null;
          toast("Your new password is saved");
          go("/", true);
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          button.disabled = false;
        }
      },
    }, error, h("div", { class: "field" }, h("label", { for: "f-password", text: "New password" }), revealable(password), h("span", { class: "help", text: "At least 8 characters." })), button)));
}

async function joinPage(token) {
  let info;
  try {
    info = await api(`/api/invites/${token}`);
  } catch (err) {
    return authLayout(h("div", { class: "card" }, h("h1", { text: "This invitation doesn't work" }), h("p", { class: "sub", text: err.message }), h("a", { class: "btn", href: "/" }, "Go to Statiku")));
  }
  const teamName = `${info.workspace}'s team`;
  const intro = h("div", {}, h("h1", { text: `Join ${teamName}` }),
    h("p", { class: "sub", text: `${info.invitedBy ?? "Someone"} invited you to see their websites' visitors on Statiku.` }));
  if (!info.valid) return authLayout(h("div", { class: "card" }, intro, h("div", { class: "error", text: "This invitation has expired or was already used. Ask for a new one." })));
  const accept = async () => {
    try {
      const { workspace } = await api(`/api/invites/${token}/accept`, { method: "POST" });
      state.sites = null;
      toast(`You've joined ${workspace}'s team`);
      go("/", true);
    } catch (err) {
      if (!(err instanceof SignedOut)) toast(err.message);
    }
  };
  if (state.user) {
    return authLayout(h("div", { class: "card" }, intro,
      h("p", { class: "muted", text: `You're signed in as ${state.user.email}.` }),
      h("button", { class: "btn primary big", type: "button", text: `Join ${teamName}`, onclick: accept })));
  }
  return authLayout(
    h("div", { class: "card" }, intro, authForm("signup", { invite: token, onDone: () => { toast(`You've joined ${teamName}`); go("/", true); } })),
    h("p", { class: "switch" }, "Already have an account? ", h("a", { href: `/login?next=${encodeURIComponent(`/join/${token}`)}`, text: "Sign in to join" })));
}

// ---------- Websites ----------
async function homePage() {
  const sites = await loadSites(true);
  const list = h("div");
  const draw = () => {
    if (!state.sites.length) {
      list.replaceChildren(
        h("div", { class: "card" }, h("div", { class: "card-body", style: { display: "grid", gap: "16px", padding: "28px" } },
          h("div", {}, h("h2", { style: { fontSize: "16px" }, text: "Add your first website" }),
            h("p", { class: "muted", style: { marginTop: "4px" }, text: "Type its address. You'll get one line to paste into your site, with steps for WordPress, Shopify, Wix, Squarespace and more." })),
          addSiteForm({ inline: true }))),
        howItWorks());
      return;
    }
    list.replaceChildren(h("div", { class: "sites" }, state.sites.map(siteCard),
      h("a", { class: "add-card", href: "/sites/new" }, icon("plus", 22), "Add another website")));
  };
  draw();
  every(15_000, async () => {
    await loadSites(true);
    draw();
  });
  return h("div", { class: "page" },
    pageHead([icon("websites", 20), h("h1", { text: "Websites" }), sites.length ? h("span", { class: "muted", text: `${sites.length} ${sites.length === 1 ? "site" : "sites"}` }) : null],
      sites.length ? h("a", { class: "btn primary", href: "/sites/new" }, icon("plus", 16), "Add website") : null),
    list);
}

function siteCard(s) {
  const ready = !!s.lastEventAt;
  return h("a", { class: "card site-card", href: ready ? `/sites/${s.key}` : `/sites/${s.key}/setup` },
    h("div", { class: "top" }, siteIcon(s, 36), h("div", { class: "who" }, h("b", { text: s.name }), s.name !== s.domains[0] ? h("span", { text: s.domains[0] }) : null),
      s.live ? h("span", { class: "live-pill" }, h("i", { class: "dot pulse" }), `${s.live} now`) : null),
    h("div", { class: "nums" },
      h("div", {}, h("b", { class: "num", text: int(s.visitorsToday) }), h("span", { text: "Visitors today" })),
      h("div", {}, h("b", { class: "num", text: int(s.pageviewsToday) }), h("span", { text: "Page views" })),
      sparkline(s.spark, { width: 110, height: 34 })),
    h("div", { class: "foot" }, ready
      ? [h("i", { class: "dot" }), `Last visit ${ago(s.lastEventAt)}`]
      : [h("i", { class: "dot idle" }), "Waiting for the first visit · ", h("span", { style: { color: "var(--link)" }, text: "Finish setup" })]));
}

function howItWorks() {
  return h("div", { class: "card", style: { marginTop: "12px" } }, h("div", { class: "card-body how-steps" },
    [["1. Add your address", "Type your website's address, like example.com."],
      ["2. Paste one line", "Copy the tracking code into your site. There are steps for every common website builder."],
      ["3. Watch visitors arrive", "See them on the live globe the moment they arrive, then where they came from and what they read."]]
      .map(([title, text]) => h("div", {}, h("b", { text: title }), h("span", { class: "muted", text })))));
}

const zones = () => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
};
function zoneSelect(id, current) {
  const list = zones();
  if (!list.includes(current)) list.unshift(current);
  return h("select", { class: "input", id }, list.map((z) => h("option", { value: z, text: z.replaceAll("_", " "), selected: z === current })));
}

function addSiteForm({ inline = false } = {}) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const error = h("div", { class: "error", role: "alert", hidden: true });
  const address = h("input", { class: `input${inline ? " big" : ""}`, id: "f-address", name: "address", type: "text", inputmode: "url", autocomplete: "url", placeholder: "example.com", required: true, spellcheck: "false" });
  const name = h("input", { class: "input", id: "f-name", name: "name", type: "text", placeholder: "Same as the address" });
  address.addEventListener("input", () => {
    const guess = address.value.trim().replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").replace(/[/?#].*$/, "");
    name.placeholder = guess || "Same as the address";
  });
  const tz = zoneSelect("f-zone", zone);
  const zoneField = h("div", { class: "field", hidden: true }, h("label", { for: "f-zone", text: "Time zone" }), tz, h("span", { class: "help", text: "Days in your reports start at midnight here." }));
  const zoneLine = h("p", { class: "muted" }, `Reports use ${zone.replaceAll("_", " ")} time. `,
    h("button", { class: "btn plain", type: "button", text: "Change", onclick: () => { zoneField.hidden = false; zoneLine.hidden = true; } }));
  const button = h("button", { class: `btn primary${inline ? " big" : ""}`, type: "submit", text: "Add website" });
  const form = h("form", {
    class: "form", novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      button.disabled = true;
      error.hidden = true;
      try {
        const { site } = await api("/api/sites", { method: "POST", body: { address: address.value, name: name.value, timezone: tz.value } });
        state.sites = null;
        go(`/sites/${site.key}/setup`);
      } catch (err) {
        if (err instanceof SignedOut) return;
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
        address.focus();
      }
    },
  }, error);
  if (inline) {
    form.append(h("div", { class: "field" }, h("label", { for: "f-address", text: "Website address" }), h("div", { class: "input-row" }, address, button)), zoneLine, zoneField);
  } else {
    form.append(
      h("div", { class: "field" }, h("label", { for: "f-address", text: "Website address" }), address,
        h("span", { class: "help", text: "The address people type to reach it. Its subdomains count too." })),
      h("div", { class: "field" }, h("label", { for: "f-name", text: "Name (optional)" }), name),
      zoneLine, zoneField, h("div", {}, button));
  }
  setTimeout(() => address.focus());
  return form;
}

function addSitePage() {
  return h("div", { class: "page narrow" },
    h("a", { class: "back", href: "/" }, icon("back", 16), "Websites"),
    pageHead([h("h1", { text: "Add a website" })]),
    h("div", { class: "card" }, h("div", { class: "card-body", style: { paddingTop: "20px" } }, addSiteForm())),
    howItWorks());
}

// ---------- Setup ----------
// A website builder's own logo in its own colour (from Simple Icons, CC0), to find yours at a glance.
function brand(logo, size = 18) {
  const t = document.createElement("template");
  t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#${logo.hex}" aria-hidden="true"><path d="${logo.path}"/></svg>`;
  return t.content.firstChild;
}
const LOGOS = { WordPress: siWordpress, Shopify: siShopify, Wix: siWix, Squarespace: siSquarespace, Webflow: siWebflow, Framer: siFramer, "Google Tag Manager": siGoogletagmanager };
const PLATFORMS = [
  ["Any website", "If you can edit your site's HTML", [
    "Copy the tracking code above.",
    "Open the HTML of your site's pages, or the shared header or layout file they all use.",
    "Paste the code just before `</head>`, and publish your site.",
  ]],
  ["WordPress", "With the free WPCode plugin, no code editing", [
    "In your WordPress admin, open Plugins → Add New Plugin and search for “WPCode”.",
    "Install and activate “WPCode – Insert Headers and Footers”.",
    "Open Code Snippets → Header & Footer.",
    "Paste the tracking code into the Header box and click Save Changes.",
  ]],
  ["Shopify", "In your theme", [
    "In Shopify admin, open Online Store → Themes.",
    "Next to your current theme, click the … button, then Edit code.",
    "Under Layout, open `theme.liquid`.",
    "Paste the tracking code just before `</head>` and click Save.",
  ]],
  ["Wix", "Needs a premium plan and a connected domain", [
    "In your site's dashboard, open Settings, then Custom code (under Advanced).",
    "Click + Add Custom Code and paste the tracking code.",
    "Name it “Statiku”, choose All pages and Load code once.",
    "Under Place code in, choose Head, then click Apply.",
  ]],
  ["Squarespace", "Needs a plan that includes code injection", [
    "Open Code Injection: in newer sites it's under Website → Pages → Website Tools; in older ones, Settings → Advanced.",
    "Paste the tracking code into the Header box.",
    "Click Save.",
  ]],
  ["Webflow", "Needs a paid site plan", [
    "Open your project's Site settings and choose Custom code.",
    "Paste the tracking code into Head code and click Save.",
    "Publish your site.",
  ]],
  ["Framer", "In site settings", [
    "Open Site Settings → General and scroll to Custom Code.",
    "Paste the tracking code into “End of <head> tag”.",
    "Publish your site.",
  ]],
  ["Google Tag Manager", "If your site already uses it", [
    "In Tag Manager, open Tags → New and choose the Custom HTML tag type.",
    "Paste the tracking code into the HTML box.",
    "Under Triggering, choose All Pages, save the tag, then Submit to publish.",
  ]],
];

async function setupPage(key) {
  const { site, snippet } = await api(`/api/sites/${key}`);
  const domain = site.domains[0];
  let lastEventAt = site.lastEventAt;

  const status = h("div", { class: "card status-card", role: "status" });
  const drawStatus = () => status.replaceChildren(...(lastEventAt
    ? [h("span", { class: "icon ok" }, icon("check", 22)),
      h("div", { class: "what" }, h("b", { text: `Statiku is counting visits on ${domain}` }), h("span", { class: "muted", text: `Last visit ${ago(lastEventAt)}.` })),
      h("a", { class: "btn primary", href: `/sites/${key}` }, "View analytics"), h("a", { class: "btn", href: `/sites/${key}/live` }, "Live view")]
    : [h("span", { class: "icon wait" }, h("i", { class: "dot idle pulse", style: { width: "12px", height: "12px" } })),
      h("div", { class: "what" }, h("b", { text: "Waiting for the first visit" }),
        h("span", { class: "muted", text: `Once the code is on your site, open ${domain} in your browser. This turns green the moment you do.` })),
      h("a", { class: "btn", href: `https://${domain}`, target: "_blank", rel: "noopener", "data-external": "" }, `Open ${domain}`, icon("external", 14))]));
  drawStatus();
  // The first visit turns this green as it arrives; a check every few seconds catches one that came in just
  // before this page opened, while it was being saved.
  const received = (at) => {
    if (lastEventAt) return;
    lastEventAt = at;
    drawStatus();
    toast(`First visit received from ${domain}`);
    state.sites = null;
  };
  const stream = new EventSource(`/api/sites/${key}/stream`);
  stream.onmessage = (m) => JSON.parse(m.data).t === "event" && received(new Date().toISOString());
  onLeave(() => stream.close());
  every(5000, async () => {
    if (lastEventAt) return;
    const at = (await api(`/api/sites/${key}`).catch(() => null))?.site.lastEventAt;
    if (at) received(at);
  });

  const copyButton = h("button", { class: "btn copy", type: "button", onclick: () => copy(snippet, copyButton) }, icon("copy", 14), "Copy");
  let platform = 0;
  const pills = h("div", { class: "platforms", role: "group", "aria-label": "Your website builder" });
  const steps = h("div", { style: { display: "grid", gap: "12px" } });
  const drawPlatform = () => {
    pills.replaceChildren(...PLATFORMS.map(([name], i) =>
      h("button", { type: "button", "aria-pressed": String(i === platform), onclick: () => { platform = i; drawPlatform(); } },
        LOGOS[name] ? brand(LOGOS[name]) : icon("globe", 18), name)));
    const [name, note, list] = PLATFORMS[platform];
    steps.replaceChildren(h("p", { class: "muted", text: `${name}: ${note}.` }), h("ol", { class: "how" }, list.map((s) => h("li", {}, h("span", {}, rich(s))))));
  };
  drawPlatform();
  const mail = `mailto:?subject=${encodeURIComponent(`Add Statiku analytics to ${domain}`)}&body=${encodeURIComponent(
    `Hi,\n\nCould you add Statiku analytics to ${domain}? It's one line, to paste just before </head> on every page:\n\n${snippet}\n\nIt sets no cookies and is under 10 KB, so it won't slow the site down.\n\nThanks!`)}`;

  const result = h("div", { role: "status" });
  const checkButton = h("button", {
    class: "btn primary", type: "button",
    onclick: async () => {
      checkButton.disabled = true;
      checkButton.textContent = "Checking…";
      try {
        const r = await api(`/api/sites/${key}/check`, { method: "POST" });
        result.replaceChildren(h("div", { class: `notice ${r.found ? "ok" : "warn"}` }, icon(r.found ? "check" : "wait"), h("span", { text: r.message })));
      } catch (err) {
        if (!(err instanceof SignedOut)) result.replaceChildren(failure(err));
      }
      checkButton.disabled = false;
      checkButton.textContent = "Check installation";
    },
  }, "Check installation");

  return h("div", { class: "page narrow" },
    pageHead([icon("code", 20), h("h1", { text: `Set up ${domain}` })]),
    h("div", { class: "stack" },
      status,
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: "1. Copy your tracking code" })),
        h("div", { class: "card-body", style: { display: "grid", gap: "10px" } },
          h("div", { class: "code-block" }, snippet, copyButton),
          h("p", { class: "muted", text: "It's under 10 KB, sets no cookies and needs no consent banner. Add it to every page you want to count." }))),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: "2. Add it to your website" }), h("span", { class: "sub", text: "Pick what your site is built with." })),
        h("div", { class: "card-body", style: { display: "grid", gap: "16px" } }, pills, steps,
          h("p", { class: "muted" }, "Someone else looks after your site? ", h("a", { href: mail, "data-external": "" }, icon("mail", 14), " Email them these instructions"), "."))),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", { text: "3. Check it's working" })),
        h("div", { class: "card-body", style: { display: "grid", gap: "12px" } },
          h("p", { class: "muted", text: `Statiku looks at ${domain}'s home page for this site's code. Or just open your site: the status at the top turns green with the first visit.` }),
          h("div", {}, checkButton), result),
        h("details", { class: "more" }, h("summary", { text: "Downloads, purchases and your own events" }),
          h("div", { class: "card-body" },
            h("p", { text: "Some things count on their own: clicks on files such as .dmg, .zip or .exe count as downloads, and clicks on Polar or Stripe checkout links as checkouts." }),
            h("p", {}, rich("To count a click on anything else, add `data-track=\"signup\"` to the link or button. From your own JavaScript:")),
            h("div", { class: "code-block", text: 'statiku("signup", { props: { plan: "pro" } })' }),
            h("p", { class: "muted" }, rich("To leave out your own visits, run `localStorage.statiku_ignore = \"1\"` in your browser's console on your site.")))),
        h("details", { class: "more" }, h("summary", { text: "Count a Mac or iPhone app too" }),
          h("div", { class: "card-body" },
            h("p", { text: "The Statiku Swift package counts installs, the versions in use and trials and licences, and links each install to the visit it was downloaded from." }),
            h("div", { class: "code-block", text: `import Statiku\n\nStatiku.start(project: "${key}")\nStatiku.setState(.trial)` }))))));
}

// ---------- Analytics ----------
const RANGES = [
  ["today", "Today", "by hour"], ["yesterday", "Yesterday", "by hour"], ["d7", "Last 7 days", "by day"],
  ["d30", "Last 30 days", "by day"], ["d90", "Last 90 days", "by day"], ["m12", "Last 12 months", "by month"],
  ["all", "All time", "since the first visit"],
];
// How a chart can be grouped, given how many days its period spans.
const UNITS = [["hour", "Hour", (days) => days <= 7], ["day", "Day", (days) => days <= 731], ["week", "Week", (days) => days >= 14],
  ["month", "Month", (days) => days >= 60], ["year", "Year", (days) => days >= 365]];
const METRICS = [
  { id: "visitors", label: "Visitors", fmt: int, tick: compact },
  { id: "visits", label: "Visits", fmt: int, tick: compact },
  { id: "pageviews", label: "Page views", fmt: int, tick: compact },
  { id: "perVisit", label: "Views per visit", fmt: (n) => (n == null ? "–" : n.toFixed(2)), tick: (n) => n.toFixed(1) },
  { id: "bounce", label: "Bounce rate", fmt: (n) => (n == null ? "–" : `${n}%`), tick: (n) => `${n}%`, lower: true },
  { id: "duration", label: "Visit duration", fmt: duration, tick: (n) => (n < 60 ? `${n}s` : `${Math.round(n / 60)}m`) },
  { id: "downloads", label: "Downloads", fmt: int, tick: compact },
  { id: "checkouts", label: "Checkouts", fmt: int, tick: compact },
];
const APP_METRICS = [
  { id: "installs", label: "New installs", fmt: int, tick: compact },
  { id: "active", label: "Installs in use", fmt: int, tick: compact },
  { id: "trials", label: "Trials started", fmt: int, tick: compact },
  { id: "licensed", label: "Licensed", fmt: int, tick: compact },
];
const LICENCE = [
  { id: "licensed", label: "Licensed", color: "var(--slot-1)" },
  { id: "trial", label: "In trial", color: "var(--slot-2)" },
  { id: "free", label: "Free", color: "var(--slot-3)" },
  { id: "expired", label: "Trial ended", color: "var(--lapsed)" },
];
const FILTER_NAMES = { source: "Source", country: "Country", device: "Device", browser: "Browser", os: "System", page: "Page" };
const filterValue = (dim, value) => (dim === "country" ? `${flag(value)} ${countryName(value)}` : value);
const withPerVisit = (t) => ({ ...t, perVisit: t.visits ? t.pageviews / t.visits : null });

// The change from the previous period, green when it's good news (for a bounce rate, a fall).
function delta(m, now, before, short = false) {
  if (now == null || !before) return h("span", { class: "delta", text: "—", title: "Nothing to compare with in the previous period" });
  const change = ((now - before) / before) * 100;
  if (Math.abs(change) < 0.5) return h("span", { class: "delta", text: short ? "0%" : "No change" });
  const good = m.lower ? change < 0 : change > 0;
  return h("span", { class: "delta" }, h("span", { class: good ? "up" : "down", text: `${change > 0 ? "↑" : "↓"} ${Math.abs(change).toFixed(0)}%` }), short ? null : " vs previous");
}

function bucketLabel(t, unit, long = false) {
  const [date, time] = t.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const when = new Date(y, mo - 1, d);
  if (unit === "hour") return long ? `${when.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}` : time;
  if (unit === "year") return String(y);
  if (unit === "week") return `${long ? "Week of " : ""}${when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: long ? "numeric" : undefined })}`;
  if (unit === "month") return when.toLocaleDateString("en-US", { month: "short", year: long ? "numeric" : undefined });
  return when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: long ? "numeric" : undefined });
}
function spanName(from, to) {
  const a = new Date(from), b = new Date(new Date(to).getTime() - 1);
  const opts = { month: "short", day: "numeric", year: "numeric" };
  return a.toDateString() === b.toDateString() ? a.toLocaleDateString("en-US", opts) : `${a.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${b.toLocaleDateString("en-US", opts)}`;
}

function bars(rows, { head, fmt = int, onPick, canPick = () => true, label = (r) => r.label, lead, active } = {}) {
  if (!rows.length) return h("p", { class: "empty-note", text: "No data for this period" });
  const max = Math.max(...rows.map((r) => r.v), 1);
  const total = rows.reduce((a, r) => a + r.v, 0);
  return h("div", { class: "bars" },
    head ? h("div", { class: "bars-head" }, h("span", { text: head[0] }), h("span", { text: head[1] })) : null,
    rows.map((r) => {
      const pickable = onPick && canPick(r);
      return h(pickable ? "button" : "div", {
        class: `bar-row${pickable && r.label === active ? " on" : ""}`, type: pickable ? "button" : null,
        title: pickable ? `Show only ${label(r)}` : null, onclick: pickable ? () => onPick(r) : null,
      }, h("span", { class: "wash", style: { width: `${(100 * r.v) / max}%` } }),
        h("span", { class: "l" }, lead?.(r), h("span", { text: label(r) })),
        h("span", { class: "r" }, fmt(r.v), h("small", { text: pct(r.v, total, 0) })));
    }));
}

function tabs(items, current, pick) {
  return h("div", { class: "tabs", role: "tablist" }, items.map(([id, label]) =>
    h("button", { type: "button", role: "tab", "aria-selected": String(id === current), text: label, onclick: () => pick(id) })));
}

// A report as a spreadsheet: totals, the period bucket by bucket, and every breakdown.
function exportCsv(d) {
  const totals = withPerVisit(d.totals), previous = withPerVisit(d.previous);
  const rows = [["Statiku report", d.site.domains[0], spanName(d.range.from, d.range.to)], [],
    ["Measure", "This period", "Previous period"], ...METRICS.map((m) => [m.label, m.fmt(totals[m.id]), m.fmt(previous[m.id])]), [],
    ["Time", ...METRICS.map((m) => m.label)], ...d.series.map((s) => withPerVisit(s)).map((s) => [bucketLabel(s.t, d.range.unit, true), ...METRICS.map((m) => s[m.id] ?? "")])];
  const section = (title, list, labelOf = (r) => r.label) => rows.push([], [title, "Visitors or visits"], ...list.map((r) => [labelOf(r), r.v]));
  section("Source", d.sources);
  section("Page", d.pages.top);
  section("Entry page", d.pages.entry);
  section("Exit page", d.pages.exit);
  section("Country", d.countries, (r) => countryName(r.label));
  section("Device", d.devices.device);
  section("Browser", d.devices.browser);
  section("Operating system", d.devices.os);
  rows.push([], ["Event", "Count", "Visits"], ...d.events.map((e) => [e.name, e.count, e.visits]));
  download(`statiku-${d.site.domains[0]}-${new Date(d.range.from).toISOString().slice(0, 10)}.csv`, rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n");
}

async function analyticsPage(key) {
  const site = state.sites.find((s) => s.key === key);
  // Filters live in the address, so a filtered report can be bookmarked or shared with the team.
  const query = new URLSearchParams(location.search);
  state.filters = Object.fromEntries(Object.keys(NO_FILTERS).map((f) => [f, query.get(f)]));
  if (query.get("range")) {
    state.range = query.get("range");
    state.from = query.get("from");
    state.to = query.get("to");
  }
  state.by = query.get("by");
  const body = h("div", {}, h("p", { class: "muted", text: "Loading…" }));
  const refreshed = h("span", { class: "muted" });
  const rangeButton = h("button", { class: "btn", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" });
  const liveButton = h("a", { class: "btn", href: `/sites/${key}/live` });
  const exportButton = h("button", { class: "btn", type: "button", disabled: true, onclick: () => data && exportCsv(data) }, icon("export", 16), "Export");
  const chips = h("div", { class: "filters", hidden: true });
  const insightsHost = h("div", { class: "stack" });
  const askHost = askCard(key, () => ({ range: state.range, from: state.from, to: state.to }));
  let data = null;

  const rangeLabel = () => (state.range === "custom" && state.from && state.to
    ? `${day(`${state.from}T12:00`)} – ${day(`${state.to}T12:00`)}`
    : state.range === "all" && data?.range.id === "all" ? `All time, since ${day(data.range.from)}`
    : RANGES.find(([id]) => id === state.range)?.[1] ?? "Last 30 days");

  const drawTools = () => {
    rangeButton.replaceChildren(icon("calendar", 16), rangeLabel(), icon("down", 14));
    rangeButton.onclick = () => {
      const today = new Date().toISOString().slice(0, 10);
      const fromInput = h("input", { class: "input", type: "date", required: true, max: today, value: state.from ?? new Date(Date.now() - 13 * 86400_000).toISOString().slice(0, 10) });
      const toInput = h("input", { class: "input", type: "date", required: true, max: today, value: state.to ?? today });
      openPopover(rangeButton, [
        ...RANGES.map(([id, label]) => menuItem([label, id === state.range ? h("span", { class: "end" }, icon("check", 16)) : null],
          () => { state.range = id; state.by = null; remember(); load(); }, { role: "menuitemradio", "aria-checked": String(id === state.range) })),
        h("form", {
          class: "custom-range",
          onsubmit: (e) => {
            e.preventDefault();
            if (!fromInput.value || !toInput.value) return;
            [state.from, state.to] = [fromInput.value, toInput.value].sort();
            state.range = "custom";
            state.by = null;
            remember();
            closePopover();
            load();
          },
        }, h("b", { text: "Custom range" }), h("div", { class: "row" }, h("label", {}, "From", fromInput), h("label", {}, "To", toInput)),
          h("button", { class: "btn primary", type: "submit", text: "Apply" })),
      ], { width: 280 });
    };
    const live = state.sites.find((s) => s.key === key)?.live ?? 0;
    liveButton.replaceChildren(h("i", { class: `dot${live ? " pulse" : " idle"}` }), live ? `${live} ${live === 1 ? "visitor" : "visitors"} now` : "Live view");
    const active = Object.entries(state.filters).filter(([, v]) => v);
    chips.hidden = !active.length;
    chips.replaceChildren(...active.map(([dim, value]) => h("span", { class: "chip" },
      h("span", {}, h("span", { class: "muted", text: `${FILTER_NAMES[dim]}${dim === "page" ? " (visits that viewed it)" : ""}: ` }), h("b", { text: filterValue(dim, value) })),
      h("button", { type: "button", "aria-label": `Remove the ${FILTER_NAMES[dim].toLowerCase()} filter`, onclick: () => setFilter(dim, null) }, icon("close", 14)))),
    ...(active.length > 1 ? [h("button", { class: "btn plain", type: "button", text: "Clear all", onclick: () => { state.filters = { ...NO_FILTERS }; load(); } })] : []));
  };

  function syncAddress() {
    const q = new URLSearchParams();
    if (state.range !== "d30") q.set("range", state.range);
    if (state.range === "custom") {
      q.set("from", state.from);
      q.set("to", state.to);
    }
    if (state.by) q.set("by", state.by);
    for (const [f, v] of Object.entries(state.filters)) if (v) q.set(f, v);
    history.replaceState({}, "", `/sites/${key}${q.size ? `?${q}` : ""}`);
  }

  async function load() {
    drawTools();
    syncAddress();
    try {
      const q = new URLSearchParams({ range: state.range });
      if (state.range === "custom") {
        q.set("from", state.from);
        q.set("to", state.to);
      }
      if (state.by) q.set("by", state.by);
      for (const [f, v] of Object.entries(state.filters)) if (v) q.set(f, v);
      data = await api(`/api/sites/${key}/stats?${q}`);
      // Assists and ratings take a little longer, so they follow the report rather than hold it up.
      const iq = new URLSearchParams({ range: state.range });
      if (state.range === "custom") {
        iq.set("from", state.from);
        iq.set("to", state.to);
      }
      api(`/api/sites/${key}/insights?${iq}`).then((x) => insightsHost.replaceChildren(...insightCards(x, key)), () => insightsHost.replaceChildren());
      refreshed.textContent = `Last refreshed ${clock().slice(0, 5)}`;
      exportButton.disabled = false;
      draw();
      waitForFirstVisit();
    } catch (err) {
      if (!(err instanceof SignedOut)) body.replaceChildren(failure(err));
    }
  }
  // A site with no visits yet listens for its first one, and the report reloads once it's written down (Statiku
  // writes every second), until the numbers show.
  let listening = null;
  const waitForFirstVisit = () => {
    if (data.lastEventAt) {
      if (!listening) return;
      listening.close();
      listening = null;
      toast(`First visit received from ${site?.domains[0] ?? "your site"}`);
      return;
    }
    if (listening) return;
    listening = new EventSource(`/api/sites/${key}/stream`);
    listening.onmessage = (m) => {
      if (JSON.parse(m.data).t === "event") setTimeout(() => loadSites(true).then(load, load), 1500);
    };
  };
  onLeave(() => listening?.close());
  const setFilter = (dim, value) => {
    state.filters = { ...state.filters, [dim]: state.filters[dim] === value ? null : value };
    window.scrollTo({ top: 0, behavior: "smooth" });
    load();
  };
  const by = (dim) => ({ onPick: (r) => setFilter(dim, r.label), active: state.filters[dim], canPick: (r) => r.label !== "Unknown" && r.label !== "Not matched" });

  function draw() {
    const d = data;
    const totals = withPerVisit(d.totals), previous = withPerVisit(d.previous);
    const unit = d.range.unit;
    // Before the first visit it's the same report, at zero, with a note on top; it fills in the moment a visit arrives.
    const domain = site?.domains[0] ?? d.site.domains[0];
    const waitingNote = !d.lastEventAt && !d.imported && !d.releases
      ? h("div", { class: "card status-card waiting" }, h("span", { class: "icon wait" }, h("i", { class: "dot idle pulse", style: { width: "12px", height: "12px" } })),
        h("div", { class: "what" }, h("b", { text: `Waiting for the first visit to ${domain}` }),
          h("span", { class: "muted", text: "Statiku is ready. These numbers fill in the moment someone opens your site; history from another tool can come in now." })),
        h("a", { class: "btn", href: `https://${domain}`, target: "_blank", rel: "noopener", "data-external": "" }, `Open ${domain}`, icon("external", 14)),
        h("a", { class: "btn plain", href: `/sites/${key}/import` }, "Import history"), h("a", { class: "btn plain", href: `/sites/${key}/setup` }, "Setup"))
      : null;
    // What history the report holds, so imported numbers are never mistaken for Statiku's own.
    const names = (d.imported?.sources ?? []).map((s) => s.label.split(":")[0]);
    const historyNote = d.imported
      ? h("div", { class: "history-note" }, icon("history", 16),
        d.imported.included
          ? h("span", {}, `Includes history imported from ${[...new Set(names)].join(" and ")}${d.imported.ownFrom ? `, for the days before ${day(`${d.imported.ownFrom}T12:00`)}, when Statiku started counting` : ""}. `)
          : h("span", { text: "Imported history isn't in filtered reports: other tools' numbers can't be narrowed by Statiku's filters. " }),
        h("a", { href: `/sites/${key}/import`, text: "Imports" }))
      : null;
    const series = d.series.map((s) => withPerVisit(s)), prevSeries = d.previousSeries.map((s) => withPerVisit(s));
    const values = (id) => series.map((s) => s[id] ?? 0);

    // Stat cards with sparklines; each picks the chart's measure.
    const kpis = h("div", { class: "grid g4" }, ["visitors", "pageviews", "bounce", "duration"].map((id) => {
      const m = METRICS.find((x) => x.id === id);
      return h("button", { class: "card kpi", type: "button", "aria-pressed": String(state.metric === id), onclick: () => { state.metric = id; draw(); } },
        h("span", { class: "label", text: m.label }), h("span", { class: "value", text: m.fmt(totals[id]) }), delta(m, totals[id], previous[id]), sparkline(values(id)));
    }));

    const m = METRICS.find((x) => x.id === state.metric) ?? METRICS[0];
    const chartHost = h("div", { class: "chart" });
    const tableHost = h("div", { class: "table-wrap", hidden: !state.table });
    const points = series.map((s) => ({ label: bucketLabel(s.t, unit, true), short: bucketLabel(s.t, unit), v: s[m.id] }));
    const compare = prevSeries.map((s) => ({ label: bucketLabel(s.t, unit, true), v: s[m.id] }));
    const toggle = h("button", { class: "btn plain", type: "button", "aria-expanded": String(state.table), text: state.table ? "Hide table" : "Show as table", onclick: () => { state.table = !state.table; draw(); } });
    // Hour, day, week, month or year, as many as suit the period.
    const days = (new Date(d.range.to) - new Date(d.range.from)) / 86400e3;
    const grouping = tabs(UNITS.filter(([, , fits]) => fits(days)).map(([id, label]) => [id, label]), unit, (id) => { state.by = id; load(); });
    tableHost.append(h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: UNITS.find(([id]) => id === unit)?.[1] ?? "Day" }), h("th", { text: m.label }), h("th", { text: "Previous period" }))),
      h("tbody", {}, points.map((p, i) => h("tr", {}, h("td", { text: p.label }), h("td", { text: m.fmt(p.v) }), h("td", { text: compare[i] ? m.fmt(compare[i].v) : "–" }))).reverse())));
    const chartCard = h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h2", { text: `${m.label} over time` }), h("div", { class: "end" }, grouping, toggle)),
      h("div", { class: "card-body" },
        h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } }, h("span", { style: { fontSize: "24px", fontWeight: 650, letterSpacing: "-0.02em" }, text: m.fmt(totals[m.id]) }), delta(m, totals[m.id], previous[m.id])),
        chartHost, tableHost));

    // The breakdown beside the chart, as on a sales report: each row picks the chart's measure.
    const breakdown = card("Traffic breakdown", h("div", {}, METRICS.map((x) =>
      h("button", {
        class: "bar-row", type: "button", style: { minHeight: "38px", borderBottom: "1px solid var(--border)", borderRadius: 0 },
        "aria-pressed": String(x.id === m.id), onclick: () => { state.metric = x.id; draw(); },
      }, h("span", { class: "l", style: { color: x.id === m.id ? "var(--text)" : "var(--link)", fontWeight: x.id === m.id ? 650 : 550 }, text: x.label }),
        h("span", { class: "r" }, x.fmt(totals[x.id]), h("small", { style: { minWidth: "4.2em" } }, delta(x, totals[x.id], previous[x.id], true)))))));

    const pageRows = d.pages[state.pagesTab];
    const content = [
      waitingNote,
      historyNote,
      kpis,
      h("div", { class: "grid g-side" }, chartCard, breakdown),
      askHost,
      h("div", { class: "grid g3" },
        card("Top sources", bars(d.sources, { head: ["Source", "Visitors"], ...by("source") }), { sub: "Click any row to filter" }),
        card("Top pages", bars(pageRows, { head: ["Page", state.pagesTab === "top" ? "Visitors" : "Visits"], ...by("page") }), {
          end: tabs([["top", "Pages"], ["entry", "Entry"], ["exit", "Exit"]], state.pagesTab, (id) => { state.pagesTab = id; draw(); }),
        }),
        card("Locations", bars(d.countries, { head: ["Country", "Visitors"], label: (r) => countryName(r.label), lead: (r) => h("span", { class: "flag", text: flag(r.label) }), ...by("country") }))),
      h("div", { class: "grid g3" },
        card("Devices", bars(d.devices.device, { head: ["Device", "Visitors"], ...by("device") })),
        card("Browsers", bars(d.devices.browser, { head: ["Browser", "Visitors"], ...by("browser") })),
        card("Operating systems", bars(d.devices.os, { head: ["System", "Visitors"], ...by("os") }))),
      conversions(d, (name) => setFilter("source", name)),
      insightsHost,
      d.releases ? releasesCard(d, values("releases")) : null,
      h("div", { class: "grid g2" },
        card("Events", d.events.length ? h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, ["Event", "Count", "Visits", ...(d.app.has ? ["Installs"] : []), "Props"].map((x) => h("th", { text: x })))),
          h("tbody", {}, d.events.map((e) => h("tr", {}, h("td", {}, h("code", { text: e.name })), h("td", { text: int(e.count) }), h("td", { text: int(e.visits) }),
            d.app.has ? h("td", { text: int(e.installs) }) : null, h("td", { class: "muted", text: e.props || "–" }))))))
          : h("p", { class: "empty-note" }, "No events yet. ", h("a", { href: `/sites/${key}/setup`, text: "How to count clicks and signups" }))),
        card("Campaigns", d.campaigns.length ? h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, ["Campaign", "Source", "Visits"].map((x) => h("th", { text: x })))),
          h("tbody", {}, d.campaigns.map((c) => h("tr", {}, h("td", { text: c.label }), h("td", { text: c.source }), h("td", { text: int(c.v) }))))))
          : h("p", { class: "empty-note" }, "Links tagged with ", h("code", { text: "utm_campaign" }), " show here."))),
      d.app.has ? appSection(d) : null,
    ];
    // Sections with nothing to show (no conversions, no app) are left out.
    body.replaceChildren(...content.filter(Boolean));
    lineChart(chartHost, points, compare, m, { current: spanName(d.range.from, d.range.to), previous: d.range.id === "all" ? null : spanName(d.range.prevFrom, d.range.prevTo) });
    drawTools();
  }

  // Charts are drawn to their width, so they're drawn again when it changes.
  let width = innerWidth;
  const resized = () => {
    if (data && Math.abs(innerWidth - width) > 20) {
      width = innerWidth;
      draw();
    }
  };
  addEventListener("resize", resized);
  onLeave(() => removeEventListener("resize", resized));
  every(60_000, load);
  queueMicrotask(load);

  return h("div", { class: "page" },
    pageHead([icon("chart", 20), h("h1", { text: "Analytics" }), h("span", { class: "muted", text: site?.domains[0] }), refreshed], [rangeButton, exportButton, liveButton]),
    chips, body);
}

// Ask your data: "what changed" in the period, worked out from the numbers, or a question in plain words, answered
// by Claude from them when the server has a key. Built once, so an answer stays while the report refreshes.
function askCard(key, period) {
  const input = h("input", { class: "input", type: "text", maxlength: "500", placeholder: "Ask about this period, like \"why did visits drop on Tuesday?\"", "aria-label": "Your question" });
  const answer = h("div", { class: "ask-answer", hidden: true, "aria-live": "polite" });
  const ask = async (question) => {
    answer.hidden = false;
    answer.replaceChildren(h("p", { class: "muted", text: question ? "Looking at your numbers…" : "Working out what changed…" }));
    try {
      const r = await api(`/api/sites/${key}/ask`, { method: "POST", body: { ...period(), question } });
      answer.replaceChildren(...[
        r.ai ? h("p", { class: "ai", text: r.answer }) : null,
        r.note ? h("p", { class: "notice", text: r.note }) : null,
        r.ai ? h("p", { class: "help", text: "Answered by Claude from this period's numbers. It can be wrong: the figures below are Statiku's own." }) : h("b", { text: "What changed" }),
        h("ul", { class: "changes" }, r.lines.map((l) => h("li", { text: l }))),
      ].filter(Boolean));
    } catch (e) {
      if (!(e instanceof SignedOut)) answer.replaceChildren(failure(e));
    }
  };
  const form = h("form", { class: "ask-row", onsubmit: (e) => { e.preventDefault(); const q = input.value.trim(); if (q) ask(q); } },
    input, h("button", { class: "btn primary", type: "submit", text: "Ask" }),
    h("button", { class: "btn", type: "button", text: "What changed?", onclick: () => ask("") }));
  return card("Ask your data", h("div", { class: "stack tight" }, form, answer), { sub: "In plain words, about the period shown" });
}

// Assists and page scores for the period, for the whole site (filters don't narrow them).
const ratingClass = (r) => (r >= 8 ? "r-top" : r >= 7 ? "r-good" : r >= 6 ? "r-ok" : "r-low");
const secs = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
function insightCards(x, key) {
  const a = x.assists, r = x.ratings;
  const tabsHost = h("span"), body = h("div");
  const show = () => {
    const tab = state.assistsTab ?? "pages";
    tabsHost.replaceChildren(tabs([["pages", "Pages"], ["sources", "Sources"], ["campaigns", "Campaigns"]], tab, (t) => { state.assistsTab = t; show(); }));
    const rows = tab === "sources" ? a.sources : a.campaigns;
    body.replaceChildren(tab === "pages"
      ? bars(a.pages, { head: ["Page", "Goals it set up"] })
      : rows.length ? h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, [tab === "sources" ? "Source" : "Campaign", "Scored", "Assisted", "Started"].map((t) => h("th", { text: t })))),
        h("tbody", {}, rows.map((s) => h("tr", {}, h("td", { text: s.label }), h("td", { text: int(s.scored) }), h("td", { text: int(s.assisted) }), h("td", { text: int(s.opened) }))))))
        : h("p", { class: "empty-note", text: tab === "sources" ? "No goals in this period." : "None of this period's goals came from a tagged campaign." }));
  };
  show();
  const assistsCard = card("Assists", a.goals
    ? h("div", { class: "stack tight" }, body,
      h("p", { class: "help", text: "Scored: the goal came in a visit from it. Assisted: an earlier visit that day came from it. Started: the day's first visit did. Pages: those seen that day before the goal." }))
    : h("p", { class: "empty-note" }, "No goals in this period. Goals are sign-ups, sales and the events you choose in ", h("a", { href: `/sites/${key}/settings#goals`, text: "Settings" }), "."),
  { sub: a.goals ? `${int(a.goals)} ${a.goals === 1 ? "goal" : "goals"}${a.multiVisit ? `, ${int(a.multiVisit)} after more than one visit that day` : ""}` : null, end: a.goals ? tabsHost : null });

  const best = r.pages.find((p) => p.path === r.best);
  const ratingsCard = card("Page scores", r.pages.length
    ? h("div", { class: "stack tight" },
      best ? h("div", { class: "motm" }, h("span", { class: "star", text: "★" }), h("span", {}, h("b", { text: "Top page: " }), h("code", { text: best.path })),
        h("span", { class: `rating ${ratingClass(best.rating)}`, text: best.rating.toFixed(1) })) : null,
      h("div", { class: "table-wrap" }, h("table", { class: "ratings" },
        h("thead", {}, h("tr", {}, ["Page", "Rating", "Visitors", "Time", "Exits", "Assists"].map((t) => h("th", { text: t })))),
        h("tbody", {}, r.pages.map((p) => h("tr", { class: p.path === r.best ? "best" : null },
          h("td", { class: "path", text: p.path }), h("td", {}, h("span", { class: `rating ${ratingClass(p.rating)}`, text: p.rating.toFixed(1) })),
          h("td", { text: int(p.visitors) }), h("td", { text: secs(p.secs) }), h("td", { text: `${p.exitRate}%` }), h("td", { text: int(p.assists) })))))),
      h("p", { class: "help", text: "Out of ten: how many visitors a page reaches, how long they stay on it, the goals it sets up, and how few visits end there." }))
    : h("p", { class: "empty-note", text: "No page views in this period." }),
  { sub: "How each page did, out of ten" });
  return [revenueCard(x.revenue, key), h("div", { class: "grid g2" }, assistsCard, ratingsCard), injuriesCard(x.injuries)];
}

// Revenue by source: the period's takings in its main currency against the one before, and what each source,
// campaign and landing page brought in.
function revenueCard(x, key) {
  if (!x.totals.length) {
    return card("Revenue", h("p", { class: "empty-note" }, "No revenue in this period. ", h("a", { href: `/sites/${key}/settings#payments`, text: "Connect Stripe or Polar" }),
      " to credit each payment to the visit that led to it, or send it with an event: ", h("code", { text: 'statiku("purchase", { revenue: { amount: 29, currency: "EUR" } })' })), { sub: "What each source earned" });
  }
  const main = x.totals[0], cur = main.currency;
  const before = x.previous.find((p) => p.currency === cur);
  const others = x.totals.slice(1);
  const tabsHost = h("span"), body = h("div");
  const show = () => {
    const tab = state.revenueTab ?? "sources";
    tabsHost.replaceChildren(tabs([["sources", "Sources"], ["campaigns", "Campaigns"], ["landings", "Landing pages"]], tab, (t) => { state.revenueTab = t; show(); }));
    const rows = x[tab].filter((r) => r.currency === cur).map((r) => ({ label: r.label, v: r.minor, sales: r.sales }));
    body.replaceChildren(rows.length ? bars(rows, { head: [tab === "sources" ? "Source" : tab === "campaigns" ? "Campaign" : "Landing page", "Revenue"], fmt: (v) => money(v, cur) })
      : h("p", { class: "empty-note", text: tab === "campaigns" ? "None of this period's sales came from a tagged campaign." : "Nothing to show." }));
  };
  show();
  const top = x.sources.find((r) => r.currency === cur && r.label !== "Not matched");
  return card("Revenue", h("div", { class: "stack tight" },
    h("div", { class: "revenue-head" },
      h("span", { class: "big-money", text: money(main.minor, cur) }),
      delta({}, main.minor, before?.minor),
      h("span", { class: "muted", text: `${int(main.sales)} ${main.sales === 1 ? "sale" : "sales"}${others.length ? ` · and ${others.map((o) => money(o.minor, o.currency)).join(", ")}` : ""}` })),
    top ? h("p", { class: "callout" }, h("b", { text: top.label }), ` brought the most: ${money(top.minor, cur)} from ${int(top.sales)} ${top.sales === 1 ? "sale" : "sales"}.`) : null,
    body),
  { sub: "What each source earned", end: tabsHost });
}

// Speed and errors: page speed as Google judges it (the 75th percentile of visits), the slowest pages, script errors and
// pages that answered with an error.
const VITALS = [
  ["lcp", "Largest paint", "How long until the page's main content shows", 2500, 4000, (v) => `${(v / 1000).toFixed(1)}s`],
  ["inp", "Response to taps", "The slowest reaction to a click, tap or key", 200, 500, (v) => `${int(v)} ms`],
  ["cls", "Layout shift", "How much the page jumps as it loads", 0.1, 0.25, (v) => v.toFixed(2)],
  ["ttfb", "First byte", "How long the server takes to answer", 800, 1800, (v) => `${int(v)} ms`],
];
const grade = (v, good, poor) => (v == null ? null : v <= good ? ["good", "Good"] : v <= poor ? ["fair", "Needs work"] : ["poor", "Poor"]);
function injuriesCard(x) {
  if (!x.vitals.samples && !x.errors.length && !x.broken.length) {
    return card("Speed and errors", h("p", { class: "empty-note", text: "Nothing measured in this period. The tracking script measures each page's speed as visitors leave it, and notes script errors and broken pages." }), { sub: "How fast pages load for visitors, and what breaks" });
  }
  const tiles = h("div", { class: "grid g4" }, VITALS.map(([id, label, hint, good, poor, fmt]) => {
    const v = x.vitals[id], g = grade(v, good, poor);
    return h("div", { class: "card kpi vital", title: hint }, h("span", { class: "label", text: label }), h("span", { class: "value", text: v == null ? "–" : fmt(v) }),
      g ? h("span", { class: `grade ${g[0]}`, text: g[1] }) : h("span", { class: "delta", text: "Not measured" }));
  }));
  const table = (head, rows) => h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((t) => h("th", { text: t })))), h("tbody", {}, rows)));
  const cellGrade = (v, i) => {
    const [, , , good, poor, fmt] = VITALS[i], g = grade(v, good, poor);
    return h("td", {}, v == null ? "–" : h("span", { class: `grade ${g[0]}`, text: fmt(v) }));
  };
  return card("Speed and errors", h("div", { class: "stack" },
    tiles,
    x.slow.length ? h("div", {}, h("h3", { class: "minor", text: "Slowest pages" }),
      table(["Page", "Largest paint", "Response", "Shift", "Visits measured"], x.slow.map((s) => h("tr", {}, h("td", { class: "path", text: s.path }), cellGrade(s.lcp, 0), cellGrade(s.inp, 1), cellGrade(s.cls, 2), h("td", { text: int(s.n) }))))) : null,
    x.errors.length ? h("div", {}, h("h3", { class: "minor", text: "Script errors" }),
      table(["Error", "Where", "Times", "Pages", "Last"], x.errors.map((e) => h("tr", {}, h("td", { class: "err", text: e.message }),
        h("td", { class: "muted", text: e.source ? `${e.source.replace(/^https?:\/\/[^/]+/, "")}${e.line ? `:${e.line}` : ""}` : e.path ?? "–" }),
        h("td", { text: int(e.n) }), h("td", { text: int(e.pages) }), h("td", { class: "muted", text: ago(e.last) }))))) : null,
    x.broken.length ? h("div", {}, h("h3", { class: "minor", text: "Broken pages" }),
      table(["Page", "Answered with", "Visits"], x.broken.map((b) => h("tr", {}, h("td", { class: "path", text: b.path }), h("td", {}, h("span", { class: "grade poor", text: String(b.status) })), h("td", { text: int(b.n) }))))) : null,
    h("p", { class: "help", text: `From ${int(x.vitals.samples)} page ${x.vitals.samples === 1 ? "view" : "views"} measured on visitors' own devices. Speed is the 75th percentile: three visits in four were at least this fast.` })),
  { sub: "How fast pages load for visitors, and what breaks" });
}

// Downloads of the GitHub repository's releases, counted by GitHub: all time, in this period, and by release.
function releasesCard(d, perBucket) {
  const r = d.releases;
  return h("div", { class: "grid g-side" },
    card("Downloads from GitHub releases", bars(r.byRelease, { head: ["Release", "Downloads, all time"] }), { sub: r.repo?.replace(/^GitHub: /, "") }),
    h("div", { class: "card kpi" }, h("span", { class: "label", text: "Release downloads" }), h("span", { class: "value", text: int(r.period) }),
      h("span", { class: "delta", text: `In this period. ${int(r.total)} all time.` }), sparkline(perBucket)));
}

// Visits that went on to download, install, check out or buy, by source, beside the steps overall.
function conversions(d, pickSource) {
  const t = d.totals, a = d.app.journey, hasApp = d.app.has;
  if (!t.downloads && !t.checkouts && !hasApp) return null;
  const steps = [
    { name: "Visits", n: t.visits },
    t.downloads || hasApp ? { name: "Downloaded", n: t.downloads, of: t.visits, ofName: "of visits" } : null,
    hasApp ? { name: "Installed", n: a.installs, of: t.downloads, ofName: "of downloads", estimate: true } : null,
    hasApp ? { name: "Licensed", n: a.licensed, of: a.installs, ofName: "of installs" } : null,
    t.checkouts ? { name: "Clicked checkout", n: t.checkouts, of: t.visits, ofName: "of visits" } : null,
  ].filter(Boolean);
  const cols = [
    ["Source", (r) => r.label], ["Visits", (r) => int(r.visits)], ["Downloads", (r) => int(r.downloads)],
    ...(hasApp ? [["Installs", (r) => int(r.installs)], ["Licensed", (r) => int(r.licensed)]] : []),
    ["Checkouts", (r) => int(r.checkouts)], ["Visit to download", (r) => pct(r.downloads, r.visits)],
  ];
  return h("div", { class: "grid g-side" },
    card("Conversions by source", h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, cols.map(([x]) => h("th", { text: x })))),
      h("tbody", {}, d.journeyBySource.map((r) => h("tr", {
        class: `pick${r.label === d.filters.source ? " on" : ""}`, tabindex: "0", onclick: () => pickSource(r.label),
        onkeydown: (e) => { if (e.key === "Enter") pickSource(r.label); },
      }, cols.map(([, value]) => h("td", { text: value(r) }))))))), { sub: "From the visit onward" }),
    card("Conversion", h("div", { class: "steps" }, steps.map((s) => h("div", { class: "step-row" },
      h("div", { class: "top" }, h("span", {}, s.name, s.estimate ? h("span", { class: "est", text: "est.", title: "Matched to a download from the same network, so an estimate" }) : null), h("b", { class: "num", text: int(s.n) })),
      h("div", { class: "track" }, h("div", { class: "fill", style: { width: `${t.visits ? Math.min(100, (100 * s.n) / t.visits) : 0}%` } })),
      h("span", { class: "rate", text: s.of != null ? `${pct(s.n, s.of)} ${s.ofName}` : "Start" }))))));
}

function appSection(d) {
  const app = d.app, unit = d.range.unit;
  const m = APP_METRICS.find((x) => x.id === state.appMetric);
  const host = h("div", { class: "chart" });
  const count = (id) => app.states.find((r) => r.label === id)?.v ?? 0;
  const shown = LICENCE.filter((s) => count(s.id));
  const total = shown.reduce((sum, s) => sum + count(s.id), 0);
  const licence = total
    ? h("div", {}, h("div", { class: "licence", role: "img", "aria-label": shown.map((s) => `${s.label}: ${int(count(s.id))}`).join(", ") },
      shown.map((s) => h("span", { title: `${s.label}: ${int(count(s.id))}`, style: { flex: `${count(s.id)} 1 0`, minWidth: "3px", background: s.color } }))),
    h("div", { class: "key-list" }, shown.map((s) => h("div", {}, h("i", { style: { background: s.color } }), h("span", { text: s.label }), h("b", { text: int(count(s.id)) }), h("small", { text: pct(count(s.id), total, 0) })))))
    : h("p", { class: "empty-note", text: "The app doesn't report its licence yet." });
  const node = h("div", {},
    h("div", { class: "page-head", style: { marginTop: "24px" } }, h("div", { class: "title" }, icon("app", 20), h("h1", { style: { fontSize: "16px" }, text: "App" }), h("span", { class: "muted", text: `Last heard from ${ago(app.lastSeen)}` }))),
    h("div", { class: "grid g4" }, APP_METRICS.map((x) =>
      h("button", { class: "card kpi", type: "button", "aria-pressed": String(x.id === state.appMetric), onclick: () => { state.appMetric = x.id; draw(); } },
        h("span", { class: "label", text: x.label }), h("span", { class: "value", text: x.fmt(app.totals[x.id]) }), delta(x, app.totals[x.id], app.previous[x.id]),
        sparkline(d.series.map((s) => s[x.id] ?? 0))))),
    h("div", { class: "card", style: { marginBottom: "12px" } }, h("div", { class: "card-head" }, h("h2", { text: `${m.label} over time` })), h("div", { class: "card-body" }, host,
      app.totals.unmatched ? h("p", { class: "muted", style: { marginTop: "8px" }, text: `${int(app.totals.unmatched)} of the ${int(app.totals.installs)} new installs had no download before them from the same network (Homebrew, another network, or a shared link). Matches are an estimate.` }) : null)),
    h("div", { class: "grid g4" },
      card("Where installs came from", bars(app.sources, { head: ["Source", "Installs"] })),
      card("Versions in use", bars(app.versions, { head: ["Version", "Installs"] })),
      card("Licence", licence),
      card("Systems", bars(app.systems, { head: ["System", "Installs"] }))));
  const draw = () => node.replaceWith(appSection(d));
  queueMicrotask(() => lineChart(host, d.series.map((s) => ({ label: bucketLabel(s.t, unit, true), short: bucketLabel(s.t, unit), v: s[m.id] })),
    d.previousSeries.map((s) => ({ label: bucketLabel(s.t, unit, true), v: s[m.id] })), m, { current: spanName(d.range.from, d.range.to), previous: spanName(d.range.prevFrom, d.range.prevTo) }));
  return node;
}

// ---------- Live view ----------
const EVENT_ICONS = { pageview: "eye", download: "download", checkout: "cart" };
function describe(e) {
  if (e.app) return e.name === "install" ? "Installed the app" : e.name === "active" ? "Opened the app" : `App: ${e.name}`;
  if (e.name === "pageview") return `Viewed ${e.path}`;
  if (e.name === "download") return "Downloaded";
  if (e.name === "checkout") return "Clicked checkout";
  return `${e.name}${e.path ? ` on ${e.path}` : ""}`;
}

async function livePage(key) {
  const site = state.sites.find((s) => s.key === key);
  const connection = h("span", { class: "badge wait" }, h("i", { class: "dot idle" }), "Connecting");
  const updated = h("span", { class: "muted" });
  const kpis = h("div", { class: "grid g4" });
  const canvas = h("canvas", { role: "img", "aria-label": "A globe of the visitors on your site right now" });
  const tip = h("div", { class: "globe-tip", hidden: true });
  const caption = h("div", { class: "caption" });
  const overCount = h("span");
  const crumbs = h("nav", { class: "crumbs", "aria-label": "Where the globe is looking" });
  const locationsTitle = h("h2", { text: "Top locations" });
  const locationsSub = h("span", { class: "sub", text: "Click one to fly there" });
  const locations = h("div"), pages = h("div"), perMinute = h("div", { class: "chart" }), sources = h("div"), feed = h("div", { class: "feed" });
  let latest = null;
  let view = { country: null, region: null, city: null, street: null };
  const osm = h("div", { class: "osm", hidden: true }, "Map © ", h("a", { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener", "data-external": "", text: "OpenStreetMap" }), " contributors");

  const globe = createGlobe(canvas, {
    onHover: (dot, x, y) => {
      if (!dot) return void (tip.hidden = true);
      const where = dot.exact ? [dot.street ?? dot.point.area ?? "Shared location", dot.city].filter(Boolean).join(", ")
        : dot.city ? [dot.city, dot.region, countryName(dot.code)].filter(Boolean).join(", ") : dot.unplaced ? `${countryName(dot.code)}, city unknown` : countryName(dot.code);
      tip.replaceChildren(h("b", {}, `${flag(dot.code)} ${where}`),
        h("span", { class: "muted", text: `${dot.v} ${dot.v === 1 ? "visitor" : "visitors"} now${dot.exact ? `, shared by them${dot.point.acc != null ? `, to within ${int(dot.point.acc)} m` : ""}` : dot.city ? ", approximately" : ""}` }));
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
      tip.hidden = false;
    },
    onView: (next) => {
      view = next;
      drawCrumbs();
      if (latest) drawLocations();
    },
    onTiles: (shown) => (osm.hidden = !shown),
  });
  onLeave(() => globe.destroy());
  const controls = h("div", { class: "globe-controls" },
    h("button", { type: "button", "aria-label": "Zoom in", title: "Zoom in", onclick: () => globe.zoomBy(2) }, icon("plus", 16)),
    h("button", { type: "button", "aria-label": "Zoom out", title: "Zoom out", onclick: () => globe.zoomBy(0.5) }, icon("minus", 16)),
    h("button", { type: "button", "aria-label": "The whole world", title: "The whole world", onclick: () => globe.world() }, icon("globe", 16)));
  const globeCard = h("div", { class: "card globe-card" }, canvas,
    h("div", { class: "over" }, h("div", { class: "where" }, h("b", { text: "Visitors right now" }), crumbs), overCount), caption, controls, osm, tip);

  // World › Finland › Kuopio: each part flies back to it.
  function drawCrumbs() {
    const parts = [h("button", { type: "button", text: "World", onclick: () => globe.world() })];
    if (view.country) {
      parts.push(h("span", { text: "›" }), h("button", { type: "button", text: countryName(view.country), onclick: () => globe.focusCountry(view.country) }));
      if (view.region && view.region !== view.city) parts.push(h("span", { text: "›" }), h("span", { class: "region", text: view.region }));
      if (view.city) parts.push(h("span", { text: "›" }), view.street ? h("button", { type: "button", text: view.city, onclick: () => { const c = latest?.cities.find((x) => x.city === view.city); if (c) globe.focusCity(c); } }) : h("b", { text: view.city }));
      if (view.street) parts.push(h("span", { text: "›" }), h("b", { text: view.street }));
    }
    crumbs.replaceChildren(...parts);
  }

  // The list beside the globe: countries, or, once the globe is on a country, that country's cities.
  function drawLocations() {
    const d = latest;
    if (!view.country) {
      locationsTitle.textContent = "Top locations";
      locationsSub.textContent = "Click one to fly there";
      return locations.replaceChildren(bars(d.countries, {
        head: ["Country", "Visitors"], label: (r) => countryName(r.label), lead: (r) => h("span", { class: "flag", text: flag(r.label) }),
        onPick: (r) => globe.focusCountry(r.label), canPick: (r) => r.label !== "Unknown",
      }));
    }
    const here = d.cities.filter((c) => c.country === view.country);
    const total = d.countries.find((c) => c.label === view.country)?.v ?? 0;
    const unplaced = total - here.reduce((sum, c) => sum + c.v, 0);
    const rows = [...here.map((c) => ({ label: c.city, region: c.region, v: c.v, city: c })), ...(unplaced > 0 ? [{ label: "City unknown", v: unplaced }] : [])];
    locationsTitle.textContent = `${flag(view.country)} ${countryName(view.country)}`;
    locationsSub.textContent = "Cities, approximately";
    // In a city, the streets of the visitors there who shared their location.
    const points = view.city ? d.exact.filter((p) => p.city === view.city && p.country === view.country) : [];
    locations.replaceChildren(...[
      rows.length ? bars(rows, { head: ["City", "Visitors"], label: (r) => (r.region && r.region !== r.label ? `${r.label} · ${r.region}` : r.label), onPick: (r) => globe.focusCity(r.city), canPick: (r) => !!r.city, active: view.city })
        : h("p", { class: "empty-note", text: "No one here right now." }),
      points.length ? h("div", { style: { marginTop: "14px" } }, bars(points.map((p) => ({ label: p.street ?? p.area ?? "Shared location", v: p.v, point: p })),
        { head: [`Shared locations in ${view.city}`, "Visitors"], onPick: (r) => globe.focusPoint(r.point), active: view.street })) : null,
      h("button", { class: "btn plain", type: "button", style: { marginTop: "8px" }, onclick: () => globe.world() }, icon("back", 14), " All countries")].filter(Boolean));
  }

  async function load() {
    try {
      latest = await api(`/api/sites/${key}/live`);
      draw();
      updated.textContent = `Updated ${clock(new Date(latest.at))}`;
    } catch (err) {
      if (!(err instanceof SignedOut)) updated.textContent = "Couldn't update. Trying again…";
    }
  }

  // Pushed from the server: each event the moment it's collected, and a nudge when someone arrives or leaves.
  // Who's here is read again at once; today's totals a moment later, once the event is saved.
  let soon = 0, later = 0;
  const refresh = () => {
    clearTimeout(soon);
    clearTimeout(later);
    soon = setTimeout(load, 250);
    later = setTimeout(load, 1600);
  };
  const stream = new EventSource(`/api/sites/${key}/stream`);
  stream.addEventListener("open", () => {
    connection.className = "badge ok";
    connection.replaceChildren(h("i", { class: "dot pulse" }), "Live");
  });
  stream.addEventListener("error", () => {
    connection.className = "badge wait";
    connection.replaceChildren(h("i", { class: "dot idle" }), "Reconnecting");
  });
  stream.onmessage = (m) => {
    const message = JSON.parse(m.data);
    onPitch(field, message);
    if (message.t === "click") return;
    if (message.t === "event" && latest) {
      latest.recent.unshift(message.e);
      latest.recent.length = Math.min(latest.recent.length, 25);
      drawFeed();
    }
    refresh();
  };
  onLeave(() => {
    stream.close();
    clearTimeout(soon);
    clearTimeout(later);
  });

  function drawFeed() {
    feed.replaceChildren(...(latest.recent.length ? latest.recent.map((e) => h("div", { class: "feed-row" },
      h("span", { class: "muted" }, icon(e.app ? "app" : EVENT_ICONS[e.name] ?? "spark", 18)),
      h("div", { class: "what" }, h("span", { text: describe(e) }),
        h("small", { text: [e.country ? `${flag(e.country)} ${countryName(e.country)}` : null, e.source, e.app ? e.os : e.browser].filter(Boolean).join(" · ") })),
      h("time", { datetime: e.ts, text: ago(e.ts) }))) : [h("p", { class: "empty-note", text: "Nothing in the last 30 minutes." })]));
  }

  function draw() {
    const d = latest;
    const s = state.sites.find((x) => x.key === key);
    if (s) s.live = d.visitors;
    const navCount = $("nav-live");
    if (navCount) {
      navCount.hidden = !d.visitors;
      navCount.lastChild.textContent = String(d.visitors);
    }
    kpis.replaceChildren(
      h("div", { class: "card kpi hero" }, h("span", { class: "label", text: "Visitors right now" }), h("span", { class: "value num" }, h("i", { class: `dot${d.visitors ? " pulse" : " idle"}`, style: { width: "12px", height: "12px" } }), int(d.visitors)),
        h("span", { class: "delta", text: "On the site this minute" })),
      ...[["Visits today", d.today.visits], ["Visitors today", d.today.visitors], ["Page views today", d.today.pageviews]].map(([label, v]) =>
        h("div", { class: "card kpi" }, h("span", { class: "label", text: label }), h("span", { class: "value num", text: int(v) }), h("span", { class: "delta", text: "Since midnight" }))));
    globe.update(d.countries, d.cities, d.exact);
    overCount.textContent = d.visitors ? `${d.visitors} in ${d.countries.length} ${d.countries.length === 1 ? "country" : "countries"}` : "";
    canvas.setAttribute("aria-label", d.visitors ? `Visitors right now: ${d.countries.map((c) => `${c.v} in ${countryName(c.label)}`).join(", ")}` : "No visitors right now");
    caption.textContent = d.visitors
      ? "Scroll, pinch or tap a country to zoom in to its cities. Drag to turn the globe."
      : "No one's on the site right now. New visitors appear the moment they arrive.";
    drawLocations();
    drawCrumbs();
    field.sync(d.walkers ?? []);
    pages.replaceChildren(bars(d.pages, { head: ["Page", "Visitors"] }));
    sources.replaceChildren(bars(d.sources, { head: ["Source", "Visitors"] }));
    minuteBars(perMinute, d.perMinute, (v) => `${v} ${v === 1 ? "page view" : "page views"}`);
    drawFeed();
  }

  // A safety net for anything the stream can't say, such as a laptop closed without a goodbye.
  every(10_000, load);
  queueMicrotask(load);
  // Everyone on the site, moving from page to page as they go.
  const field = pitch();
  // Momentum changes by the five minutes: asked for once a minute.
  const momentumHost = h("div", {}, h("p", { class: "muted", text: "Loading…" }));
  const loadMomentum = () => api(`/api/sites/${key}/momentum`).then((m) => momentumHost.replaceChildren(momentumView(m)), () => {});
  every(60_000, loadMomentum);
  queueMicrotask(loadMomentum);

  return h("div", { class: "page" },
    pageHead([icon("live", 20), h("h1", { text: "Live view" }), connection, h("span", { class: "muted", text: site?.domains[0] }), updated],
      [h("a", { class: "btn", href: `/sites/${key}/match` }, icon("ball", 16), "Match view"), h("a", { class: "btn", href: `/sites/${key}` }, icon("chart", 16), "Analytics")]),
    kpis,
    h("div", { class: "grid g-globe" }, globeCard,
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("div", { class: "card-head" }, locationsTitle, locationsSub), h("div", { class: "card-body" }, locations)),
        card("Pages being viewed", pages))),
    h("div", { class: "grid g3" },
      card("Page views per minute", perMinute, { sub: "Last 30 minutes" }),
      card("Sources right now", sources),
      card("Recent activity", feed, { sub: "Last 30 minutes" })),
    card("On the move", field.el, { sub: "Each visitor on the page they're on, live, as they go from page to page and click" }),
    card("Momentum", momentumHost, { sub: "Who's attacking: the last two hours against the same time last week" }),
    h("p", { class: "faint", style: { fontSize: "12px", marginTop: "4px" } },
      "Locations are approximate, from each visitor's IP address (",
      h("a", { href: "https://db-ip.com", target: "_blank", rel: "noopener", "data-external": "", text: "IP Geolocation by DB-IP" }),
      "). Cities are used only for this view while people are on the site, and are never stored. ",
      site?.role === "owner" ? h("a", { href: `/sites/${key}/settings#location`, text: "Exact locations from visitors who agree to share them" }) : null));
}

// ---------- A site's settings ----------
// ---------- Import history ----------
// Numbers from before Statiku, from another tool or from GitHub. They fill the days before Statiku's own first visit.
const IMPORT_KINDS = {
  ga4: { name: "Google Analytics", logo: siGoogleanalytics },
  plausible: { name: "Plausible", logo: siPlausibleanalytics },
  github: { name: "GitHub releases", logo: siGithub },
  file: { name: "A file", logo: null },
};
const FILE_TOOLS = [siFathom, siMatomo, siUmami, siSimpleanalytics, siCloudflare];

async function importPage(key) {
  const site = state.sites.find((s) => s.key === key);
  const owner = site?.role === "owner";
  const query = new URLSearchParams(location.search);
  let info = await api(`/api/sites/${key}/imports`);
  const listHost = h("div");
  const logoOf = (kind, size = 20) => (IMPORT_KINDS[kind]?.logo ? brand(IMPORT_KINDS[kind].logo, size) : icon("file", size));
  const reload = async () => {
    info = await api(`/api/sites/${key}/imports`);
    drawList();
  };
  // A running import is checked on every few seconds until it's done.
  every(2500, () => info.imports.some((x) => x.status === "running") && reload());
  const started = async (promise, button) => {
    button.disabled = true;
    try {
      await promise;
      toast("Import started");
      history.replaceState({}, "", `/sites/${key}/import`);
      await reload();
      listHost.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      if (!(err instanceof SignedOut)) toast(err.message);
    } finally {
      button.disabled = false;
    }
  };

  function drawList() {
    if (!info.imports.length) return listHost.replaceChildren();
    listHost.replaceChildren(card("Your imports", h("div", { class: "imports" }, info.imports.map((x) => {
      const days = x.firstDay && x.lastDay ? `${day(`${x.firstDay}T12:00`)}, ${x.firstDay.slice(0, 4)} – ${day(`${x.lastDay}T12:00`)}, ${x.lastDay.slice(0, 4)}` : null;
      const status = x.status === "running" ? h("span", { class: "muted" }, h("i", { class: "dot idle pulse" }), " Importing…")
        : x.status === "failed" ? h("span", { class: "bad", text: x.error ?? "It failed." })
        : h("span", { class: "muted", text: [days, x.kind === "github" && x.refreshedAt ? `refreshed ${ago(x.refreshedAt)}` : null].filter(Boolean).join(" · ") });
      return h("div", { class: "import-row" }, h("span", { class: "logo" }, logoOf(x.kind)),
        h("div", { class: "what" }, h("b", { text: x.label }), status, x.note ? h("span", { class: "muted small", text: x.note }) : null),
        owner && x.status !== "running" ? h("button", {
          class: "btn plain", type: "button", "aria-label": `Delete ${x.label}`,
          onclick: async () => {
            if (!(await confirmDialog({ title: "Delete this import?", body: `${x.label}: its numbers leave every report. You can import it again later.`, confirm: "Delete", danger: true }))) return;
            await api(`/api/sites/${key}/imports/${x.id}`, { method: "DELETE" });
            toast("Import deleted");
            reload();
          },
        }, icon("trash", 16)) : null);
    })), { sub: "Imported days are counted only before Statiku's own first visit, and a day two imports share is counted once." }));
  }
  drawList();

  // Each source opens its own small form.
  let fields = 0;
  const field = (label, input, help) => {
    // The input itself, also when it comes with its show button around it.
    const control = input.querySelector("input") ?? input;
    control.id = `i-${++fields}`;
    return h("div", { class: "field" }, h("label", { for: control.id, text: label }), input, help ? h("span", { class: "help", text: help }) : null);
  };
  const error = query.get("error");

  // Google Analytics: sign in with Google, then pick the property.
  const google = h("div", { class: "form" });
  if (query.get("google")) {
    const pick = h("select", { class: "input" }, h("option", { text: "Loading your properties…" }));
    const importButton = h("button", { class: "btn primary", type: "button", text: "Import", disabled: true });
    google.append(field("Google Analytics 4 property", pick), importButton);
    api(`/api/sites/${key}/imports/google/properties?grant=${encodeURIComponent(query.get("google"))}`).then(({ properties }) => {
      pick.replaceChildren(...properties.map((p) => h("option", { value: p.id, text: `${p.name} (${p.account}, ${p.id})` })));
      if (!properties.length) pick.replaceChildren(h("option", { text: "This Google account has no GA4 properties" }));
      importButton.disabled = !properties.length;
      importButton.onclick = () => started(api(`/api/sites/${key}/imports`, {
        method: "POST", body: { kind: "ga4", grant: query.get("google"), property: pick.value, name: properties.find((p) => p.id === pick.value)?.name },
      }), importButton);
    }, (err) => google.replaceChildren(failure(err), h("a", { class: "btn", href: `/api/sites/${key}/imports/google/start`, "data-external": "", text: "Connect again" })));
  } else {
    google.append(h("a", { class: info.google ? "btn primary" : "btn", href: `/api/sites/${key}/imports/google/start`, "data-external": "" }, brand(siGoogleanalytics, 16), "Connect Google Analytics"),
      info.google ? null : h("span", { class: "help", text: "Signing in with Google isn't set up on this server yet. Download a CSV from Google Analytics and add it as a file instead." }));
  }

  // Plausible: a Stats API key.
  const pKey = h("input", { class: "input", type: "password", autocomplete: "off", placeholder: "Stats API key" });
  const pSite = h("input", { class: "input", value: site?.domains[0] ?? "" });
  const pHost = h("input", { class: "input", value: "https://plausible.io" });
  const pGo = h("button", { class: "btn primary", type: "submit", text: "Import" });
  const plausible = h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); started(api(`/api/sites/${key}/imports`, { method: "POST", body: { kind: "plausible", key: pKey.value, site: pSite.value, host: pHost.value } }), pGo); } },
    field("Stats API key", revealable(pKey, "key"), "In Plausible: your account settings → API Keys → New API Key, for the Stats API."),
    field("Site, as Plausible names it", pSite), field("Plausible's address", pHost, "Change this only if you host Plausible yourself."), pGo);

  // GitHub: the repository whose releases people download.
  const gRepo = h("input", { class: "input", placeholder: "owner/repository" });
  const gToken = h("input", { class: "input", type: "password", autocomplete: "off", placeholder: "Only for a private repository" });
  const gGo = h("button", { class: "btn primary", type: "submit", text: "Import" });
  const githubForm = h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); started(api(`/api/sites/${key}/imports`, { method: "POST", body: { kind: "github", repo: gRepo.value, token: gToken.value } }), gGo); } },
    field("Repository", gRepo, "Every release's downloads so far, on the day it came out; then what they gain, every day."),
    field("Token", revealable(gToken, "token"), `A fine-grained token with read access to the repository's contents.${info.tokens ? "" : " This server doesn't keep tokens, so it's used once."}`), gGo);

  // A file from any other tool.
  const input = h("input", { type: "file", multiple: true, accept: ".csv,.tsv,.txt,.zip", hidden: true });
  const fGo = h("button", { class: "btn primary", type: "button", text: "Choose files" });
  const send = (files) => {
    if (!files.length) return;
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name);
    started(fetch(`/api/sites/${key}/imports/file`, { method: "POST", body: form, credentials: "same-origin" }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "That couldn't be imported.");
    }), fGo);
  };
  input.onchange = () => send([...input.files]);
  fGo.onclick = () => input.click();
  const drop = h("div", {
    class: "drop", ondragover: (e) => { e.preventDefault(); drop.classList.add("over"); }, ondragleave: () => drop.classList.remove("over"),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove("over"); send([...e.dataTransfer.files]); },
  }, icon("file", 22), h("b", { text: "Drop CSV or ZIP files here" }), h("span", { class: "muted", text: "Several at once is fine: they become one import." }), fGo, input);
  const fileForm = h("div", { class: "form" }, drop,
    h("div", { class: "tools" }, FILE_TOOLS.map((logo) => h("span", { title: logo.title }, brand(logo, 16), logo.title))),
    h("p", { class: "help", text: "Export daily numbers, a row for each day, with visitors, visits or page views; sources, pages or countries can come as files of their own. Plausible's ZIP export, Google Analytics' CSV downloads and Umami's data export work as they are." }));

  const source = (kind, title, sub, body) => h("div", { class: "card import-source" },
    h("div", { class: "card-head" }, h("span", { class: "logo" }, logoOf(kind, 22)), h("div", {}, h("h2", { text: title }), h("span", { class: "sub", text: sub }))),
    h("div", { class: "card-body" }, body));

  return h("div", { class: "page narrow" },
    pageHead([icon("history", 20), h("h1", { text: "Import history" }), h("span", { class: "muted", text: site?.domains[0] })]),
    h("p", { class: "lede", text: "Statiku counts from the moment its code is on your site. Bring in what another tool counted before, and your reports reach back to your first visitor." }),
    error ? h("div", { class: "error", role: "alert", text: error }) : null,
    owner ? h("div", { class: "grid g2 import-sources" },
      source("ga4", "Google Analytics", "Sign in with Google and pick a property", google),
      source("plausible", "Plausible", "With a Stats API key", plausible),
      source("github", "GitHub releases", "Download counts of your app's releases", githubForm),
      source("file", "From a file", "Fathom, Matomo, Umami, Simple Analytics, a spreadsheet…", fileForm))
      : h("p", { class: "muted", text: "Only the site's owner can import history." }),
    listHost);
}

async function siteSettingsPage(key) {
  const { site, snippet } = await api(`/api/sites/${key}`);
  const owner = site.role === "owner";
  const saveSite = async (body, button, message) => {
    button.disabled = true;
    try {
      await api(`/api/sites/${key}`, { method: "PATCH", body });
      state.sites = null;
      toast(message);
      render();
    } catch (err) {
      if (!(err instanceof SignedOut)) toast(err.message);
      button.disabled = false;
    }
  };

  // Emails to the owners when the site goes quiet or down, and when a rush of visitors arrives.
  const alertsCard = () => {
    const quiet = h("input", { type: "checkbox", id: "s-quiet", checked: site.alertQuiet, disabled: !owner });
    const surge = h("input", { type: "checkbox", id: "s-surge", checked: site.alertSurge, disabled: !owner });
    const save = h("button", { class: "btn primary", type: "button", text: "Save", hidden: !owner, onclick: () => saveSite({ alertQuiet: quiet.checked, alertSurge: surge.checked }, save, "Alerts saved") });
    return card("Alerts", h("div", { class: "form" },
      h("label", { class: "check", for: "s-quiet" }, quiet, h("span", {}, h("b", { text: "When the site goes quiet. " }),
        h("span", { class: "muted", text: "An hour without visits at a time it usually has them: Statiku looks at the site and says whether it's down, lost its tracking code, or is just quiet. Then again when visits come back." }))),
      h("label", { class: "check", for: "s-surge" }, surge, h("span", {}, h("b", { text: "When a rush arrives. " }),
        h("span", { class: "muted", text: "Many times the usual visitors in a quarter of an hour, and where they're coming from, while it's happening. At most one every six hours." }))),
      h("p", { class: "help", text: "Emails go to the site's owners." }), owner ? h("div", {}, save) : null), { id: "alerts" });
  };

  // The weekly match report: by email to the owners, and to a Slack channel through an incoming webhook.
  const reportCard = () => {
    const weekly = h("input", { type: "checkbox", id: "s-report", checked: site.reportWeekly, disabled: !owner });
    const hook = h("input", { class: "input", id: "s-slack", type: "url", placeholder: site.slack ? "Connected: paste a new one to replace it" : "https://hooks.slack.com/services/…", disabled: !owner });
    const save = h("button", { class: "btn primary", type: "button", text: "Save", hidden: !owner, onclick: () => saveSite({ reportWeekly: weekly.checked, ...(hook.value.trim() ? { slackWebhook: hook.value.trim() } : {}) }, save, "Report settings saved") });
    const unhook = h("button", { class: "btn plain", type: "button", text: "Stop posting to Slack", onclick: () => saveSite({ slackWebhook: null }, unhook, "Slack disconnected") });
    const now = h("button", { class: "btn", type: "button", text: "Send me last week's report now", onclick: async () => {
      now.disabled = true;
      try {
        const r = await api(`/api/sites/${key}/report`, { method: "POST" });
        toast(`Sent: ${r.heading}`);
      } catch (e) {
        if (!(e instanceof SignedOut)) toast(e.message);
      } finally {
        now.disabled = false;
      }
    } });
    return card("Weekly match report", h("div", { class: "form" },
      h("p", { class: "muted", text: "Every Monday morning, last week against the week before, read like a result: visitors, visits, goals and revenue each won or lost (\"you beat last week 3–1\"), the star player, the top scorer, the assist of the week, the injuries and your numbers." }),
      h("label", { class: "check", for: "s-report" }, weekly, h("span", {}, h("b", { text: "Email it to the site's owners." }))),
      h("div", { class: "field" }, h("label", { for: "s-slack", text: "Post it to Slack too" }), hook,
        h("span", { class: "help" }, "An incoming webhook for the channel: in Slack, ", h("code", { text: "Apps → Incoming Webhooks → Add to Slack" }), ", pick the channel, and paste its address here.")),
      h("div", { class: "row-gap" }, owner ? save : null, owner && site.slack ? unhook : null, now)), { id: "report" });
  };

  // Goals: the events the match view cheers, assists credit and the match report counts.
  const goalsCard = () => {
    const goals = h("input", { class: "input", id: "s-goals", value: (site.goals ?? []).join(", "), placeholder: site.defaultGoals.join(", "), disabled: !owner });
    const save = h("button", { class: "btn primary", type: "button", text: "Save", hidden: !owner, onclick: () => saveSite({ goals: goals.value.trim() ? goals.value : null }, save, "Goals saved") });
    return card("Goals", h("div", { class: "form" },
      h("p", { class: "muted", text: "The events that count as a goal: the match view cheers them, assists credit the pages and sources that led to them, and the weekly match report counts them. Anything that earns money counts too." }),
      h("div", { class: "field" }, h("label", { for: "s-goals", text: "Events, separated by commas" }), goals,
        h("span", { class: "help", text: site.goals ? "Leave it empty for the usual ones." : `Empty: the usual ones, ${site.defaultGoals.slice(0, 6).join(", ")} and the like.` })),
      owner ? h("div", {}, save) : null), { id: "goals" });
  };

  // Payments: each provider's webhook, so a payment is credited to the visit that led to it.
  const paymentsCard = () => {
    const pay = site.payments;
    const provider = (id, name, connected, url, steps) => {
      const secret = h("input", { class: "input", type: "password", autocomplete: "off", placeholder: "whsec_…", "aria-label": `${name} webhook signing secret`, disabled: !owner || !pay.canSeal });
      const field = id === "stripe" ? "stripeSecret" : "polarSecret";
      const save = h("button", { class: "btn primary", type: "button", text: connected ? "Replace the secret" : "Connect", onclick: () => secret.value.trim() ? saveSite({ [field]: secret.value.trim() }, save, `${name} connected`) : toast("Paste the webhook's signing secret first.") });
      const off = h("button", { class: "btn plain", type: "button", text: "Disconnect", onclick: () => saveSite({ [field]: null }, off, `${name} disconnected`) });
      const copyUrl = h("button", { class: "btn copy", type: "button", onclick: () => copy(url, copyUrl) }, icon("copy", 14), "Copy");
      return h("div", { class: "provider" },
        h("div", { class: "row-between" }, h("b", { text: name }), h("span", { class: `badge${connected ? " ok" : ""}`, text: connected ? "Connected" : "Not connected" })),
        h("ol", { class: "steps-list" }, steps.map((t) => h("li", {}, rich(t)))),
        h("div", { class: "code-block small" }, url, copyUrl),
        owner ? h("div", { class: "input-row" }, revealable(secret, "secret"), save, connected ? off : null) : null);
    };
    return card("Payments", h("div", { class: "form" },
      h("p", { class: "muted", text: "Checkout links on your site (buy.stripe.com and buy.polar.sh) get a reference when they're clicked. Your payment provider's webhook brings it back with the payment, so each sale is credited to the source, campaign and page that led to it." }),
      pay.canSeal ? null : h("div", { class: "notice warn", text: "This server needs a SECRET_KEY setting to keep payment secrets." }),
      provider("stripe", "Stripe", pay.stripe, pay.stripeUrl, ["In Stripe, open `Developers → Webhooks` and add a destination.", "Choose the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`, and this address:", "Paste the signing secret Stripe shows (`whsec_…`) here."]),
      provider("polar", "Polar", pay.polar, pay.polarUrl, ["In Polar, open `Settings → Webhooks` and add an endpoint, format Raw.", "Choose the event `order.paid`, and this address:", "Paste its secret here."])), { id: "payments" });
  };

  const name = h("input", { class: "input", id: "s-name", value: site.name, disabled: !owner });
  const zone = zoneSelect("s-zone", site.timezone);
  zone.disabled = !owner;
  const saveGeneral = h("button", { class: "btn primary", type: "submit", text: "Save", hidden: !owner });

  let domains = [...site.domains];
  const domainList = h("div", { style: { display: "grid", gap: "6px" } });
  const newDomain = h("input", { class: "input", placeholder: "shop.example.com", "aria-label": "Another domain" });
  const saveDomains = h("button", { class: "btn primary", type: "button", text: "Save domains", onclick: () => saveSite({ domains }, saveDomains, "Domains saved") });
  const drawDomains = () => domainList.replaceChildren(...domains.map((d, i) => h("div", { class: "bar-row", style: { background: "var(--surface-2)" } },
    h("span", { class: "l", text: d }), owner && domains.length > 1 ? h("button", { class: "btn plain", type: "button", text: "Remove", onclick: () => { domains.splice(i, 1); drawDomains(); } }) : h("span", { class: "faint", text: i === 0 ? "Main" : "" }))));
  drawDomains();

  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete ${site.domains[0]}?`, body: "This deletes the site and every visit and event it collected. It can't be undone.", confirm: "Delete site", danger: true, typed: site.domains[0] }))) return;
    try {
      await api(`/api/sites/${key}`, { method: "DELETE", body: { confirm: site.domains[0] } });
      state.sites = null;
      toast(`${site.domains[0]} deleted`);
      go("/");
    } catch (err) {
      if (!(err instanceof SignedOut)) toast(err.message);
    }
  };
  const copyButton = h("button", { class: "btn copy", type: "button", onclick: () => copy(snippet, copyButton) }, icon("copy", 14), "Copy");

  // Exact location: off unless the owner turns it on, and then each visitor decides for themselves.
  const asking = h("input", { type: "checkbox", id: "s-location", checked: !!site.askLocation, disabled: !owner });
  const policy = "If you choose to share your location when our site asks, we see your address, as closely as your device can tell, on a live map of the people on the site right now. We see it only while you're on the site, and it isn't stored. The address is looked up from OpenStreetMap, which receives your location to about 10 metres.";
  const copyPolicy = h("button", { class: "btn copy", type: "button", onclick: () => copy(policy, copyPolicy) }, icon("copy", 14), "Copy");
  const saveLocation = h("button", {
    class: "btn primary", type: "button", text: "Save", hidden: !owner,
    onclick: () => saveSite({ askLocation: asking.checked }, saveLocation, asking.checked ? "Visitors will be asked to share their location" : "Visitors won't be asked any more"),
  });
  const locationCard = card("Exact location in the live view", h("div", { class: "form" },
    h("p", { class: "muted", text: "The live view places visitors in their approximate city, from their IP address. To see someone's street and house number, they have to share their location themselves. With this on, visitors see this a few seconds after they arrive:" }),
    h("div", { class: "ask-preview", "aria-hidden": "true" }, h("p", { text: `${site.domains[0]} would like to access your location` }),
      h("div", {}, h("span", { text: "Not now" }), h("span", { class: "yes", text: "Share" }))),
    h("p", { class: "muted", text: "Only if they tap Share does their browser ask them, and only if they allow it there do they appear in your live view at their address, while they're on the site. The house number shows when their device is sure of it to within 25 metres, as phones usually are; otherwise the street. Their location is never stored, and they aren't asked again during their visit. Expect most visitors to say no." }),
    h("label", { class: "check", for: "s-location" }, asking, "Ask my visitors to share their location"),
    h("div", { class: "field" }, h("span", { style: { fontWeight: 550 }, text: "Add this to your privacy policy before you turn it on:" }), h("div", { class: "code-block", style: { fontFamily: "var(--font)", wordBreak: "normal" } }, policy, copyPolicy)),
    h("div", {}, saveLocation)), { id: "location" });
  if (location.hash) setTimeout(() => $(location.hash.slice(1))?.scrollIntoView({ block: "start" }));

  return h("div", { class: "page narrow" },
    pageHead([icon("settings", 20), h("h1", { text: "Site settings" }), h("span", { class: "muted", text: site.domains[0] })]),
    h("div", { class: "stack" },
      owner ? null : h("div", { class: "notice", text: "Only the site's owner can change these settings." }),
      card("Site", h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); saveSite({ name: name.value, timezone: zone.value }, saveGeneral, "Saved"); } },
        h("div", { class: "field" }, h("label", { for: "s-name", text: "Name" }), name),
        h("div", { class: "field" }, h("label", { for: "s-zone", text: "Time zone" }), zone, h("span", { class: "help", text: "Days in your reports start at midnight here." })),
        h("div", {}, saveGeneral))),
      card("Domains", h("div", { class: "form" },
        h("p", { class: "muted", text: "Pages on these addresses and their subdomains are counted. Visits from anywhere else are turned away, so no one can send made-up visits from their own site." }),
        domainList,
        owner ? h("form", { class: "input-row", onsubmit: (e) => { e.preventDefault(); const d = newDomain.value.trim(); if (d && !domains.includes(d)) { domains.push(d); newDomain.value = ""; drawDomains(); } } },
          newDomain, h("button", { class: "btn", type: "submit", text: "Add" })) : null,
        owner ? h("div", {}, saveDomains) : null)),
      card("Tracking code", h("div", { style: { display: "grid", gap: "10px" } }, h("div", { class: "code-block" }, snippet, copyButton),
        h("a", { href: `/sites/${key}/setup`, text: "Steps for WordPress, Shopify, Wix and more" }))),
      alertsCard(),
      reportCard(),
      goalsCard(),
      paymentsCard(),
      locationCard,
      owner ? h("div", { class: "card", style: { borderColor: "#fbd5d0" } }, h("div", { class: "card-head" }, h("h2", { text: "Delete site" })),
        h("div", { class: "card-body form" },
          h("p", { class: "muted", text: "This deletes the site and every visit and event it collected. It can't be undone." }),
          h("div", {}, h("button", { class: "btn critical", type: "button", text: "Delete this site", onclick: remove })))) : null));
}

// ---------- Account settings ----------
async function accountPage() {
  const sites = await loadSites(true);
  const user = state.user;
  const status = (form, message, ok = true) => {
    const note = form.querySelector(".form-status") ?? form.appendChild(h("div", { class: "form-status" }));
    note.replaceChildren(h("div", { class: `notice ${ok ? "ok" : "warn"}`, role: "status" }, icon(ok ? "check" : "wait"), h("span", { text: message })));
  };

  // Profile: the photo is cropped square and shrunk to 256 pixels here, before it's sent.
  const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return toast("That file isn't a photo Statiku can read.");
    const canvas = h("canvas", { width: 256, height: 256 });
    const side = Math.min(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
    try {
      state.user = (await api("/api/me/photo", { method: "POST", body: { image: canvas.toDataURL("image/jpeg", 0.88) } })).user;
      toast("Photo saved");
      render();
    } catch (err) {
      if (!(err instanceof SignedOut)) toast(err.message);
    }
  });
  const removePhoto = async () => {
    state.user = (await api("/api/me/photo", { method: "DELETE" })).user;
    toast("Photo removed");
    render();
  };
  const nameInput = h("input", { class: "input", id: "a-name", value: user.name, autocomplete: "name" });
  const emailInput = h("input", { class: "input", id: "a-email", type: "email", value: user.email, autocomplete: "email" });
  const profile = h("form", {
    class: "form",
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        state.user = (await api("/api/me", { method: "PATCH", body: { name: nameInput.value, email: emailInput.value } })).user;
        toast("Saved");
        render();
      } catch (err) {
        if (!(err instanceof SignedOut)) status(profile, err.message, false);
      }
    },
  },
  h("div", { class: "photo-edit" }, photo(user, 64), fileInput,
    h("button", { class: "btn", type: "button", onclick: () => fileInput.click() }, user.photo ? "Change photo" : "Upload photo"),
    user.photo ? h("button", { class: "btn plain", type: "button", text: "Remove", onclick: removePhoto }) : null),
  h("div", { class: "field" }, h("label", { for: "a-name", text: "Name" }), nameInput),
  h("div", { class: "field" }, h("label", { for: "a-email", text: "Email" }), emailInput),
  h("div", {}, h("button", { class: "btn primary", type: "submit", text: "Save" })));

  // Websites: every site, to edit or remove.
  const removeSite = async (s) => {
    if (!(await confirmDialog({ title: `Delete ${s.domains[0]}?`, body: "This deletes the site and every visit and event it collected. It can't be undone.", confirm: "Delete site", danger: true, typed: s.domains[0] }))) return;
    try {
      await api(`/api/sites/${s.key}`, { method: "DELETE", body: { confirm: s.domains[0] } });
      state.sites = null;
      toast(`${s.domains[0]} deleted`);
      render();
    } catch (err) {
      if (!(err instanceof SignedOut)) toast(err.message);
    }
  };
  const websites = sites.length
    ? h("div", {}, sites.map((s) => h("div", { class: "person-row" }, siteIcon(s, 32),
      h("div", { class: "who" }, h("b", { text: s.name }), h("span", { text: `${s.domains.join(", ")}${s.role === "owner" ? "" : " · shared with you"}` })),
      h("div", { class: "end" }, h("a", { class: "btn", href: `/sites/${s.key}/settings` }, "Edit"),
        s.role === "owner" ? h("button", { class: "btn", type: "button", "aria-label": `Delete ${s.domains[0]}`, title: "Delete", onclick: () => removeSite(s) }, icon("trash", 16)) : null))),
    h("div", { style: { paddingTop: "12px" } }, h("a", { class: "btn", href: "/sites/new" }, icon("plus", 16), "Add website")))
    : h("p", { class: "empty-note" }, "No websites yet. ", h("a", { href: "/sites/new", text: "Add one" }));

  // Team: who can see your websites, and links that invite more.
  const team = h("div", {}, h("p", { class: "muted", text: "Loading…" }));
  const drawTeam = async (link) => {
    let t;
    try {
      t = await api("/api/team");
    } catch (err) {
      if (!(err instanceof SignedOut)) team.replaceChildren(failure(err));
      return;
    }
    const linkInput = link ? h("input", { class: "input", value: link, readonly: true, "aria-label": "Invitation link", onfocus: (e) => e.target.select() }) : null;
    const copyLink = link ? h("button", { class: "btn", type: "button", onclick: () => copy(link, copyLink) }, icon("copy", 14), "Copy") : null;
    team.replaceChildren(
      h("p", { class: "muted", text: `People in your team see ${t.workspace.sites === 1 ? "your website and its numbers" : `all ${t.workspace.sites} of your websites and their numbers`}. Only you can add, change or delete websites.` }),
      h("div", { style: { marginTop: "8px" } }, t.members.map((m) => h("div", { class: "person-row" }, photo(m.you ? state.user : { name: m.name, email: m.email }, 32),
        h("div", { class: "who" }, h("b", { text: m.you ? `${m.name} (you)` : m.name }), h("span", { text: m.email })),
        h("div", { class: "end" }, h("span", { class: "badge", text: m.role === "owner" ? "Owner" : "Member" }),
          !m.you && m.role !== "owner" ? h("button", {
            class: "btn plain", type: "button", text: "Remove",
            onclick: async () => {
              if (!(await confirmDialog({ title: `Remove ${m.name}?`, body: `${m.name} won't see your websites any more.`, confirm: "Remove", danger: true }))) return;
              await api(`/api/team/members/${m.id}`, { method: "DELETE" });
              drawTeam();
            },
          }) : null)))),
      t.invites.length ? h("div", { style: { marginTop: "12px" } }, h("b", { text: "Open invitations" }), t.invites.map((i) => h("div", { class: "person-row" }, photo(null, 32),
        h("div", { class: "who" }, h("b", { text: "Invitation link" }), h("span", { text: `Made by ${i.by ?? "you"} ${ago(i.created_at)} · works until ${day(i.expires_at)}` })),
        h("div", { class: "end" }, h("button", { class: "btn plain", type: "button", text: "Cancel", onclick: async () => { await api(`/api/team/invites/${i.id}`, { method: "DELETE" }); drawTeam(); } }))))) : null,
      link ? h("div", { class: "notice", style: { marginTop: "12px", display: "grid", gap: "8px" } },
        h("span", { text: "Send this link to the person you're inviting. It works once, for 7 days, and is shown only now." }),
        h("div", { class: "link-box" }, linkInput, copyLink)) : null,
      h("div", { style: { marginTop: "12px" } }, h("button", {
        class: "btn primary", type: "button",
        onclick: async () => {
          const created = await api("/api/team/invites", { method: "POST" });
          await drawTeam(created.link);
          team.querySelector(".link-box input")?.select();
        },
      }, icon("plus", 16), "Create an invitation link")));
  };
  drawTeam();

  // Password: a new one signs out every other browser.
  const current = h("input", { class: "input", id: "p-current", type: "password", autocomplete: "current-password" });
  const next = h("input", { class: "input", id: "p-next", type: "password", autocomplete: "new-password", minlength: "8" });
  const password = h("form", {
    class: "form",
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api("/api/me/password", { method: "POST", body: { current: current.value, password: next.value } });
        current.value = next.value = "";
        status(password, "Password changed. Other browsers signed in to this account were signed out.");
      } catch (err) {
        if (!(err instanceof SignedOut)) status(password, err.message, false);
      }
    },
  },
  h("div", { class: "field" }, h("label", { for: "p-current", text: "Current password" }), revealable(current)),
  h("div", { class: "field" }, h("label", { for: "p-next", text: "New password" }), revealable(next), h("span", { class: "help", text: "At least 8 characters." })),
  h("div", {}, h("button", { class: "btn primary", type: "submit", text: "Change password" })));

  // Closing the account.
  const closePassword = h("input", { class: "input", id: "d-password", type: "password", autocomplete: "current-password" });
  const close = h("form", {
    class: "form",
    onsubmit: async (e) => {
      e.preventDefault();
      if (!(await confirmDialog({ title: "Delete your account?", body: "Your account goes, and so do the websites only you can see, with everything they collected. Websites you share with others stay with them. This can't be undone.", confirm: "Delete my account", danger: true, typed: state.user.email }))) return;
      try {
        await api("/api/me", { method: "DELETE", body: { password: closePassword.value } });
        state.user = null;
        state.sites = null;
        go("/signup", true);
      } catch (err) {
        if (!(err instanceof SignedOut)) status(close, err.message, false);
      }
    },
  },
  h("p", { class: "muted", text: "This deletes your account and the websites only you can see, with every visit and event they collected." }),
  h("div", { class: "field" }, h("label", { for: "d-password", text: "Your password" }), revealable(closePassword)),
  h("div", {}, h("button", { class: "btn critical", type: "submit", text: "Delete account" })));

  if (location.hash) setTimeout(() => $(location.hash.slice(1))?.scrollIntoView({ block: "start" }));
  return h("div", { class: "page narrow" },
    pageHead([icon("settings", 20), h("h1", { text: "Settings" })]),
    h("div", { class: "stack" },
      card("Profile", profile),
      card("Websites", websites, { sub: `${sites.length} ${sites.length === 1 ? "site" : "sites"}`, id: "websites" }),
      card("Team", team, { id: "team" }),
      card("Password", password),
      h("div", { class: "card", style: { borderColor: "#fbd5d0" } }, h("div", { class: "card-head" }, h("h2", { text: "Delete account" })), h("div", { class: "card-body" }, close))));
}

// ---------- Trackers ----------
// Anything a site sends from anywhere, with its secret key, or uploads in a file: a number (installs, a score, a
// temperature), a word ("Online", the song playing) or a yes/no. Each tracker is a tile, live: the Trackers page has
// every site's, and Add tracker has the key, the call that sends a value, and the upload.
const num = (v) => (v == null ? "–" : Number(v).toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 }));
const NUMBER_RANGES = [["today", "Today"], ["d7", "7 days"], ["d30", "30 days"], ["m12", "12 months"], ["all", "All time"]];

// A tracker's tile: its value for the period (an "add" tracker's total, any other's latest), the change on the
// previous period, its line (a word tracker's last few words instead), and when it last moved. update() takes a value
// as it arrives.
function numberTile(n, { owner = false, onDelete = null, big = false } = {}) {
  const words = n.kind === "text";
  const value = h("span", { class: `value${words ? " word" : ""}` });
  const when = h("span", { class: "muted small" });
  const line = h("span", { class: "spark-host" });
  const tile = h("div", { class: `card kpi number-tile${big ? " big" : ""}` },
    h("span", { class: "label" }, h("span", { text: n.name }), h("span", { class: "kind", text: n.kind === "add" ? "Total" : "Latest" }),
      owner && onDelete ? h("button", { class: "btn plain icon-only", type: "button", "aria-label": `Delete ${n.name}`, title: "Delete", onclick: onDelete }, icon("trash", 14)) : null),
    value, !words && n.previous != null ? delta({}, n.value, n.previous) : h("span", { class: "delta", text: n.kind === "add" ? "In this period" : " " }), line, when);
  const paint = () => {
    value.textContent = words ? n.value ?? n.last?.value ?? "–" : num(n.value ?? (n.kind === "add" ? 0 : n.last?.value));
    when.textContent = n.last ? `Updated ${ago(n.last.ts)}` : "Nothing yet";
    if (words) {
      const before = (n.recent ?? []).slice(1, 4).map((r) => r.text);
      line.replaceChildren(before.length ? h("span", { class: "before", text: `Before: ${before.join(" · ")}` }) : "");
      return;
    }
    // A latest-value number holds its value through the hours nothing was sent; a total is 0 then.
    let held = n.series.find((p) => p.v != null)?.v ?? 0;
    line.replaceChildren(sparkline(n.series.map((p) => (n.kind === "add" ? p.v ?? 0 : (held = p.v ?? held))), { ...(big ? { width: 320, height: 44 } : {}), fit: n.kind !== "add" }));
  };
  paint();
  tile.data = n;
  tile.update = (v, ts) => {
    if (words) {
      n.value = v;
      n.recent = [{ ts, text: v }, ...(n.recent ?? [])].slice(0, 5);
    } else {
      n.value = n.kind === "add" ? (n.value ?? 0) + v : v;
      const end = n.series.at(-1);
      if (end) end.v = n.kind === "add" ? (end.v ?? 0) + v : v;
    }
    n.last = { value: v, ts };
    paint();
    tile.classList.remove("flash");
    void tile.offsetWidth;
    tile.classList.add("flash");
  };
  return tile;
}

// Every site's trackers, a group of tiles each, live.
function trackersPage() {
  let range = saved.homeNumbersRange ?? "today", data = null;
  const tiles = new Map();
  const rangeTabs = h("span");
  const body = h("div", { class: "stack" }, h("p", { class: "muted", text: "Loading…" }));
  const streams = new Map();
  const load = async () => {
    rangeTabs.replaceChildren(tabs(NUMBER_RANGES, range, (id) => { range = id; saved.homeNumbersRange = id; remember(); load(); }));
    try {
      data = await api(`/api/numbers?range=${range}`);
      draw();
    } catch (err) {
      if (!(err instanceof SignedOut)) body.replaceChildren(failure(err));
    }
  };
  const remove = (site, n) => async () => {
    if (!(await confirmDialog({ title: `Delete ${n.name}?`, body: "Every value it has, sent or uploaded, is deleted. Sending it again starts it afresh.", confirm: "Delete", danger: true }))) return;
    await api(`/api/sites/${site.key}/numbers/${encodeURIComponent(n.name)}`, { method: "DELETE" }).then(() => { toast(`${n.name} deleted`); load(); }, (e) => toast(e.message));
  };
  const draw = () => {
    tiles.clear();
    const withTrackers = data.sites.filter((s) => s.numbers.length);
    if (!withTrackers.length) {
      body.replaceChildren(h("div", { class: "card status-card" }, h("span", { class: "icon wait" }, icon("track", 20)),
        h("div", { class: "what" }, h("b", { text: "No trackers yet" }),
          h("span", { class: "muted", text: "Track anything from a script, a server or a device, or upload a file of it: a number (installs, a score, a temperature), a word (\"Online\", the song playing) or a yes/no. Each one shows here, live." })),
        h("a", { class: "btn primary", href: "/trackers/new" }, icon("plus", 16), "Add tracker")));
      return;
    }
    body.replaceChildren(...withTrackers.map((s) => h("div", { class: "number-group" },
      h("div", { class: "row-between" }, h("b", { text: s.name }), s.role === "owner" ? h("a", { class: "btn plain", href: `/trackers/new?site=${s.key}`, text: "Send or upload values" }) : null),
      h("div", { class: "grid g4 numbers" }, s.numbers.map((n) => {
        const tile = numberTile(n, { owner: s.role === "owner", onDelete: remove(s, n) });
        tiles.set(`${s.key}:${n.name}`, tile);
        return tile;
      })))));
    // New values straight onto their tiles, for up to six sites at once.
    for (const s of withTrackers.slice(0, 6)) {
      if (streams.has(s.key)) continue;
      const stream = new EventSource(`/api/sites/${s.key}/stream`);
      stream.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.t !== "number") return;
        const tile = tiles.get(`${s.key}:${msg.n.name}`);
        if (tile) tile.update(msg.n.value, msg.n.ts);
        else setTimeout(load, 1500);
      };
      streams.set(s.key, stream);
    }
  };
  onLeave(() => streams.forEach((x) => x.close()));
  every(60_000, load);
  queueMicrotask(load);
  return h("div", { class: "page" },
    pageHead([icon("track", 20), h("h1", { text: "Trackers" })], [rangeTabs, h("a", { class: "btn primary", href: "/trackers/new" }, icon("plus", 16), "Add tracker")]), body);
}

// Adding a tracker to one of your sites: its key (shown once, when it's made), the same call in a few languages,
// and a file upload. A tracker begins with its first value.
async function addTrackerPage(preset = null) {
  const owned = state.sites.filter((s) => s.role === "owner");
  const asked = preset ?? new URLSearchParams(location.search).get("site");
  let site = owned.find((s) => s.key === asked) ?? owned[0];
  if (!site) {
    return h("div", { class: "page narrow" }, pageHead([icon("track", 20), h("h1", { text: "Add a tracker" })]),
      h("div", { class: "notice", text: "Trackers belong to a website you own. Add a website first, and its trackers will be here." }));
  }
  let hasKey = (await api(`/api/sites/${site.key}/numbers?range=today`).catch(() => ({ hasKey: false }))).hasKey, shownKey = null;
  const origin = location.origin;
  const body = h("div", { class: "stack" });
  const pick = h("select", { class: "input", id: "t-site", "aria-label": "Website", onchange: async (e) => {
    site = owned.find((s) => s.key === e.target.value);
    shownKey = null;
    hasKey = (await api(`/api/sites/${site.key}/numbers?range=today`).catch(() => ({ hasKey: false }))).hasKey;
    history.replaceState({}, "", `/trackers/new?site=${site.key}`);
    draw();
  } }, owned.map((s) => h("option", { value: s.key, selected: s.key === site.key ? true : null, text: s.name === s.domains[0] ? s.name : `${s.name} (${s.domains[0]})` })));

  function sendCard() {
    const k = shownKey ?? "YOUR_KEY";
    const examples = {
      curl: `curl ${origin}/v1/track \\\n  -H "Authorization: Bearer ${k}" \\\n  -d '{"name": "Home goals", "value": 2}'`,
      JavaScript: `await fetch("${origin}/v1/track", {\n  method: "POST",\n  headers: { Authorization: "Bearer ${k}" },\n  body: JSON.stringify({ name: "Status", value: "Online" }),\n});`,
      Python: `import requests\n\nrequests.post("${origin}/v1/track",\n  headers={"Authorization": "Bearer ${k}"},\n  json={"name": "Installs", "value": 1, "op": "add"})`,
      "An address": `${origin}/v1/track?key=${k}&name=Temperature&value=21.5`,
    };
    let tab = saved.numbersTab && examples[saved.numbersTab] ? saved.numbersTab : "curl";
    const code = h("div", { class: "code-block" });
    const copyButton = h("button", { class: "btn copy", type: "button", onclick: () => copy(examples[tab], copyButton) }, icon("copy", 14), "Copy");
    const tabHost = h("span");
    const show = () => {
      code.replaceChildren(examples[tab], copyButton);
      tabHost.replaceChildren(tabs(Object.keys(examples).map((t) => [t, t]), tab, (t) => { tab = t; saved.numbersTab = t; remember(); show(); }));
    };
    show();
    const makeKey = async () => {
      if (hasKey && !(await confirmDialog({ title: "Make a new key?", body: "The key you have now stops working at once. Anything sending values with it needs the new one.", confirm: "Make a new key", danger: true }))) return;
      try {
        shownKey = (await api(`/api/sites/${site.key}/numbers/key`, { method: "POST" })).key;
        hasKey = true;
        draw();
      } catch (e) {
        toast(e.message);
      }
    };
    const keyCopy = h("button", { class: "btn copy", type: "button", onclick: () => copy(shownKey, keyCopy) }, icon("copy", 14), "Copy");
    const keyPart = shownKey
      ? h("div", { class: "field" }, h("span", { style: { fontWeight: 550 }, text: "Your key. Copy it now: it's shown only this once." }), h("div", { class: "code-block" }, shownKey, keyCopy))
      : h("div", { class: "row-between" },
        h("span", { class: "muted", text: hasKey ? "This site has a key. It was shown once, when it was made; make a new one if you've lost it." : "Values are sent with a secret key of the site's own." }),
        h("button", { class: hasKey ? "btn" : "btn primary", type: "button", text: hasKey ? "Make a new key" : "Create a key", onclick: makeKey }));
    return card("Send a value", h("div", { class: "form" }, keyPart, tabHost, code,
      h("p", { class: "help" }, "A value is a number, a word or a yes/no, and a new name starts a new tracker. Use ", h("code", { text: '"op": "add"' }),
        " for a number that counts up, such as installs or sales: each value is added to its total. Anything else keeps its latest value. Add ", h("code", { text: '"ts"' }),
        " for a value from another time. Keep the key on servers and devices: on a web page anyone could read it."),
    ), { sub: "From a script, a server or a device" });
  }

  function uploadCard() {
    const input = h("input", { type: "file", accept: ".csv,.tsv,.txt", hidden: true });
    const choose = h("button", { class: "btn", type: "button", text: "Choose a file", onclick: () => input.click() });
    const send = async (files) => {
      if (!files.length) return;
      const form = new FormData();
      for (const f of files) form.append("file", f, f.name);
      choose.disabled = true;
      try {
        const res = await fetch(`/api/sites/${site.key}/numbers/upload`, { method: "POST", body: form, credentials: "same-origin" });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error ?? "That file couldn't be read.");
        toast(`${int(out.saved)} values for ${out.names.length === 1 ? out.names[0] : `${out.names.length} trackers`} uploaded`);
      } catch (e) {
        toast(e.message);
      } finally {
        choose.disabled = false;
      }
    };
    input.onchange = () => send([...input.files]);
    const drop = h("div", {
      class: "drop", ondragover: (e) => { e.preventDefault(); drop.classList.add("over"); }, ondragleave: () => drop.classList.remove("over"),
      ondrop: (e) => { e.preventDefault(); drop.classList.remove("over"); send([...e.dataTransfer.files]); },
    }, icon("file", 22), h("b", { text: "Drop a CSV file here" }), choose, input);
    return card("Upload values", h("div", { class: "form" }, drop,
      h("div", { class: "code-block small", text: "time,name,value\n2026-11-01,Home goals,1\n2026-11-01T21:40,Status,Online" }),
      h("p", { class: "help", text: 'A row for each value, with "time", "name" and "value" columns; or a "time" column and a column for each tracker. Times are dates (2026-11-01) or times (2026-11-01T21:40).' })),
    { sub: "Past results, readings, exports" });
  }

  function draw() {
    body.replaceChildren(
      h("div", { class: "card" }, h("div", { class: "card-body form" }, h("div", { class: "field" }, h("label", { for: "t-site", text: "Website" }), pick,
        h("span", { class: "help", text: "Each website has its own key; its trackers show under its name on the Trackers page." })))),
      sendCard(), uploadCard());
  }
  draw();
  return h("div", { class: "page narrow" }, pageHead([icon("track", 20), h("h1", { text: "Add a tracker" })], h("a", { class: "btn", href: "/trackers" }, "See your trackers")), body);
}

// ---------- Heatmaps ----------
// Where a page's visitors click and how far down they read: the page itself (if it lets itself be shown in a frame)
// with the clicks over it as heat, the links and buttons clicked most, and lines where each share of visits stopped.
const DEVICE_WIDTHS = { Mobile: 390, Tablet: 820, Laptop: 1280, Desktop: 1536, Unknown: 1280 };
// The height of each kind of screen: the window the page is shown in.
const VIEW_HEIGHTS = { Mobile: 780, Tablet: 1100, Laptop: 800, Desktop: 900, Unknown: 800 };
const HEAT_RANGES = [["today", "Today"], ["d7", "7 days"], ["d30", "30 days"], ["d90", "90 days"]];

let heatPalette = null;
function drawHeat(canvas, clicks, width, height) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!clicks.length) return;
  const radius = Math.max(16, width / 36), most = Math.max(...clicks.map((c) => c.n));
  for (const c of clicks) {
    const x = c.x * width, y = c.y;
    if (y > height + radius) continue;
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `rgba(0,0,0,${Math.min(1, 0.18 + (0.82 * c.n) / most)})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  // Each shade of grey becomes its colour: blue where few clicked, through green and yellow, to red where most did.
  if (!heatPalette) {
    const p = document.createElement("canvas");
    p.width = 256;
    p.height = 1;
    const pc = p.getContext("2d");
    const lg = pc.createLinearGradient(0, 0, 256, 0);
    [[0, "#3b5bff"], [0.35, "#00d0ff"], [0.55, "#3ddc84"], [0.75, "#ffe03d"], [1, "#ff3b30"]].forEach(([o, c]) => lg.addColorStop(o, c));
    pc.fillStyle = lg;
    pc.fillRect(0, 0, 256, 1);
    heatPalette = pc.getImageData(0, 0, 256, 1).data;
  }
  const img = ctx.getImageData(0, 0, width, height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (!a) continue;
    d[i] = heatPalette[a * 4];
    d[i + 1] = heatPalette[a * 4 + 1];
    d[i + 2] = heatPalette[a * 4 + 2];
    d[i + 3] = Math.min(225, 60 + a);
  }
  ctx.putImageData(img, 0, 0);
}

async function heatmapsPage(key) {
  const site = state.sites.find((s) => s.key === key);
  const domain = site?.domains[0];
  let range = saved.heatRange ?? "d30", path = null, device = null, showPage = saved.heatPage !== false, data = null;
  const body = h("div", {}, h("p", { class: "muted", text: "Loading…" }));
  const tools = h("div", { class: "tools-row" });
  // The page in the frame talks to this one (its Statiku script, in heatmap mode): how far it's scrolled, how tall.
  let listen = () => {};
  const heard = (e) => listen(e);
  addEventListener("message", heard);
  onLeave(() => removeEventListener("message", heard));
  let fitNow = () => {};
  const resized = () => fitNow();
  addEventListener("resize", resized);
  onLeave(() => removeEventListener("resize", resized));

  async function load() {
    const q = new URLSearchParams({ range });
    if (path) q.set("path", path);
    if (device) q.set("device", device);
    try {
      data = await api(`/api/sites/${key}/heatmap?${q}`);
      path = data.path;
      device = data.device;
      draw();
    } catch (err) {
      if (!(err instanceof SignedOut)) body.replaceChildren(failure(err));
    }
  }

  function draw() {
    const d = data;
    const pagePick = h("select", { class: "input", "aria-label": "Page", onchange: (e) => { path = e.target.value; device = null; load(); } },
      d.pages.map((p) => h("option", { value: p.path, selected: p.path === d.path ? true : null, text: `${p.path} (${int(p.clicks)} clicks)` })));
    tools.replaceChildren(...[d.pages.length ? pagePick : null,
      d.devices.length > 1 ? tabs(d.devices.map((x) => [x.device, x.device]), d.device, (id) => { device = id; load(); }) : null,
      tabs(HEAT_RANGES, range, (id) => { range = id; saved.heatRange = id; remember(); path = null; device = null; load(); })].filter(Boolean));
    if (!d.path) {
      body.replaceChildren(h("div", { class: "card status-card" }, h("span", { class: "icon wait" }, icon("heat", 20)),
        h("div", { class: "what" }, h("b", { text: "No clicks in this period yet" }),
          h("span", { class: "muted", text: "The tracking script notes where visitors click and how far down they read, without recording their screens. The first heatmap shows here once a page has some clicks." }))));
      return;
    }
    const width = DEVICE_WIDTHS[d.device] ?? 1280, view = VIEW_HEIGHTS[d.device] ?? 800;
    let pageHeight = Math.min(12000, Math.max(d.height ?? 0, ...d.clicks.map((c) => c.y + 40), view));
    // Live: the page itself in a window of a screen's height, scrolled like a browser, with the heat following it.
    // Blank: the whole page's height on a plain background, for pages that can't be shown or don't say where they are.
    let live = showPage, synced = false;
    const frame = h("iframe", { src: `https://${domain}${d.path}${d.path.includes("#") ? "&" : "#"}statiku-heatmap`, title: `${d.path} on ${domain}`, sandbox: "allow-scripts allow-same-origin", style: { width: `${width}px`, height: `${view}px` } });
    const canvas = h("canvas", { class: "heat-layer", role: "img", "aria-label": `Where visitors clicked on ${d.path}` });
    const marks = h("div", { class: "scroll-marks" });
    const layer = h("div", { class: "heat-page" }, canvas, marks);
    const inner = h("div", { class: "heat-inner" }, frame, layer);
    const stage = h("div", { class: "heat-stage" }, inner);
    const note = h("p", { class: "help" });
    const paintLayer = () => {
      layer.style.width = `${width}px`;
      layer.style.height = `${pageHeight}px`;
      marks.replaceChildren(...d.scroll.filter((s) => s.depth % 20 === 0 && s.depth < 100).map((s) =>
        h("div", { class: "scroll-mark", style: { top: `${(s.depth / 100) * pageHeight}px` } }, h("span", { text: `${s.share}% read this far` }))));
      drawHeat(canvas, d.clicks, width, pageHeight);
    };
    const fit = () => {
      const tall = live ? view : pageHeight, scale = Math.min(1, (stage.clientWidth || width) / width);
      inner.style.width = `${width}px`;
      inner.style.height = `${tall}px`;
      inner.style.transform = `scale(${scale})`;
      stage.style.height = `${tall * scale}px`;
    };
    const mode = () => {
      stage.classList.toggle("blank", !live);
      frame.hidden = !live;
      if (!live) layer.style.transform = "none";
      note.textContent = live
        ? "Scroll the page to see further down. Your own visit to it here isn't counted, and its links don't open."
        : showPage ? "This page can't be shown here: it doesn't allow other sites to frame it, or doesn't run Statiku's script. The heat is where people clicked, on a blank page as tall as yours."
          : "The heat is where people clicked, on a blank page as tall as yours.";
      fit();
    };
    listen = (e) => {
      if (e.source !== frame.contentWindow || e.data?.statiku !== "heatmap") return;
      synced = true;
      if (!live) return;
      const h2 = Math.min(12000, Math.max(view, Number(e.data.h) || view));
      if (Math.abs(h2 - pageHeight) > 4) {
        pageHeight = h2;
        paintLayer();
      }
      layer.style.transform = `translateY(${-(Number(e.data.y) || 0)}px)`;
    };
    // A page that hasn't said where it is within a few seconds can't be followed: shown blank instead.
    if (live) setTimeout(() => { if (!synced && frame.isConnected) { live = false; mode(); } }, 7000);
    const toggle = h("label", { class: "check" }, h("input", { type: "checkbox", checked: showPage, onchange: (e) => { showPage = e.target.checked; saved.heatPage = showPage; remember(); draw(); } }), "Show the page behind");
    const total = d.clicks.reduce((a, c) => a + c.n, 0);
    body.replaceChildren(h("div", { class: "grid g-side heat-grid" },
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, h("code", { text: d.path })), h("span", { class: "sub", text: `${int(total)} clicks · ${int(d.views)} views · ${d.device}` }), h("div", { class: "end" }, toggle)),
        h("div", { class: "card-body" }, stage,
          h("div", { class: "heat-legend" }, h("span", { text: "Fewer clicks" }), h("i"), h("span", { text: "More clicks" })), note)),
      h("div", { class: "stack" },
        card("Clicked most", bars(d.targets, { head: ["Link or button", "Clicks"] })),
        card("How far down they read", d.scroll.length ? bars(d.scroll.map((s) => ({ label: `${s.depth}% of the page`, v: s.share })), { head: ["Reached", "Visits"], fmt: (v) => `${v}%` })
          : h("p", { class: "empty-note", text: "No visits have closed this page yet." }), { sub: d.scrolled ? `${int(d.scrolled)} visits` : null }))));
    fitNow = fit;
    queueMicrotask(() => {
      paintLayer();
      mode();
    });
  }

  queueMicrotask(load);
  return h("div", { class: "page" }, pageHead([icon("heat", 20), h("h1", { text: "Heatmaps" }), h("span", { class: "muted", text: domain })], [tools]), body);
}

// ---------- The pitch ----------
// Everyone on the site right now, as a dot on the page they're on: a dot runs on when its visitor arrives, glides to
// the next page as they go, ripples when they click a link or button (with its text), and fades when they leave. A
// zone for each page they're on, the busiest first, and "other pages" once there are more than seven. Dots are the
// colour of the source that brought them.
const WALKER_COLOURS = ["#29c46b", "#2fb3eb", "#f5a524", "#e8590c", "#8b7cf6", "#e64980", "#12b886", "#4c6ef5"];
function pitch({ dark = false } = {}) {
  const zonesHost = h("div", { class: "pitch-zones" }), dotsHost = h("div", { class: "pitch-dots" }), legend = h("div", { class: "pitch-legend" });
  const empty = h("p", { class: "pitch-empty", text: "No one's on the site right now. Visitors appear here the moment they arrive." });
  const field = h("div", { class: `pitch${dark ? " dark" : ""}` }, h("div", { class: "pitch-lines", "aria-hidden": "true" }, h("i"), h("b")), zonesHost, dotsHost, empty);
  const zones = [], walkers = new Map(), colours = new Map();
  const MAX = 8, OTHER = "\u0000other";
  const hash = (text) => { let x = 7; for (const c of text) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };
  const colourOf = (source) => {
    if (!colours.has(source)) colours.set(source, WALKER_COLOURS[colours.size % WALKER_COLOURS.length]);
    return colours.get(source);
  };
  const zoneFor = (path) => {
    const known = zones.find((z) => z.path === path);
    if (known) return known;
    const open = zones.length < MAX - 1 || (zones.length < MAX && !zones.some((z) => z.path === OTHER));
    if (!open) return zones.find((z) => z.path === OTHER) ?? addZone(OTHER);
    return addZone(path);
  };
  function addZone(path) {
    const count = h("b", { text: "0" });
    const el = h("div", { class: "pitch-zone" }, h("span", { class: "name", text: path === OTHER ? "Other pages" : path === "/" ? "Home" : path }), count);
    const zone = { path, el, count };
    zones.push(zone);
    zonesHost.append(el);
    layout();
    return zone;
  }
  // Zones in a grid of up to four across (two on a phone); each dot at its own spot in its zone, the same each time.
  let across = 4;
  new ResizeObserver(() => {
    const fits = field.clientWidth && field.clientWidth < 520 ? 2 : 4;
    if (fits !== across) {
      across = fits;
      layout();
    }
  }).observe(field);
  function layout() {
    if (!zones.length) return;
    const cols = Math.min(across, zones.length), rows = Math.ceil(zones.length / cols);
    zones.forEach((z, i) => {
      const c = i % cols, r = Math.floor(i / cols), w = 100 / cols, hgt = 100 / rows;
      Object.assign(z, { x: c * w, y: r * hgt, w, h: hgt });
      Object.assign(z.el.style, { left: `calc(${z.x}% + 6px)`, top: `calc(${z.y}% + 6px)`, width: `calc(${w}% - 12px)`, height: `calc(${hgt}% - 12px)` });
    });
    for (const [s, walker] of walkers) place(s, walker);
  }
  function place(s, walker) {
    const z = walker.zone, k = hash(s);
    walker.x = z.x + z.w * (0.14 + 0.72 * ((k % 997) / 997));
    walker.y = z.y + z.h * (0.42 + 0.44 * (((k >>> 10) % 991) / 991));
    walker.el.style.left = `${walker.x}%`;
    walker.el.style.top = `${walker.y}%`;
  }
  function counts() {
    for (const z of zones) z.count.textContent = String([...walkers.values()].filter((w) => w.zone === z).length);
    empty.hidden = walkers.size > 0;
    const sources = [...new Set([...walkers.values()].map((w) => w.source))].slice(0, 6);
    legend.replaceChildren(...sources.map((src) => h("span", {}, h("i", { style: { background: colourOf(src) } }), src)));
  }
  function arrive(s, w) {
    const colour = colourOf(w.source ?? "Direct");
    const el = h("i", { class: "walker", style: { background: colour, color: colour, left: "-3%", top: `${20 + (hash(s) % 60)}%` }, title: [w.source, w.city].filter(Boolean).join(" · ") });
    dotsHost.append(el);
    const walker = { el, source: w.source ?? "Direct", zone: zoneFor(w.path ?? "/"), seen: Date.now() };
    walkers.set(s, walker);
    // Placed on the next frame, so it runs on from the edge.
    requestAnimationFrame(() => requestAnimationFrame(() => place(s, walker)));
    return walker;
  }
  const api = {
    el: h("div", { class: "pitch-wrap" }, field, legend),
    // Who's there by the live view's latest count: the new run on, those who moved go, those gone a while leave.
    sync(list) {
      const here = new Set();
      for (const w of list) {
        here.add(w.s);
        const known = walkers.get(w.s);
        if (!known) arrive(w.s, w);
        else if (known.zone.path !== w.path && zoneFor(w.path ?? "/") !== known.zone) api.move(w.s, w.path, w);
        else known.seen = Date.now();
      }
      for (const [s, walker] of walkers) if (!here.has(s) && Date.now() - walker.seen > 30_000) api.leave(s);
      counts();
    },
    move(s, path, info = {}) {
      const walker = walkers.get(s);
      if (!walker) arrive(s, { ...info, path });
      else {
        walker.zone = zoneFor(path ?? "/");
        walker.seen = Date.now();
        place(s, walker);
      }
      counts();
    },
    click(s, target) {
      const walker = walkers.get(s);
      if (!walker) return;
      walker.seen = Date.now();
      const kick = h("span", { class: "kick", style: { left: `${walker.x}%`, top: `${walker.y}%` } }, target ? h("em", { text: target.length > 26 ? `${target.slice(0, 25)}…` : target }) : null);
      dotsHost.append(kick);
      setTimeout(() => kick.remove(), 2400);
    },
    seen(s) {
      const walker = walkers.get(s);
      if (walker) walker.seen = Date.now();
    },
    leave(s) {
      const walker = walkers.get(s);
      if (!walker) return;
      walkers.delete(s);
      walker.el.classList.add("gone");
      setTimeout(() => walker.el.remove(), 700);
      counts();
    },
  };
  // A visitor not heard from for a minute and a half has gone, as in the live count.
  const sweep = setInterval(() => { for (const [s, w] of walkers) if (Date.now() - w.seen > 95_000) api.leave(s); }, 10_000);
  onLeave(() => clearInterval(sweep));
  counts();
  return api;
}
// What a live message means for the pitch.
function onPitch(p, msg) {
  if (msg.t === "event" && msg.e.s && msg.e.name === "pageview") p.move(msg.e.s, msg.e.path, msg.e);
  else if (msg.t === "click") p.click(msg.c.s, msg.c.target);
  else if (msg.t === "presence" && msg.s) msg.gone ? p.leave(msg.s) : p.seen(msg.s);
}

// ---------- Match view ----------
// A site's day as a live scoreboard: for a TV, a launch day, or a link to share.
const money = (minor, currency) => {
  try {
    const f = new Intl.NumberFormat("en", { style: "currency", currency });
    return f.format(minor / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${minor} ${currency}`;
  }
};
const EVENT_NAMES = { signup: "Sign-up", sign_up: "Sign-up", register: "Sign-up", subscribe: "Subscription", trial: "Trial", purchase: "Sale", order: "Order", checkout: "Checkout", download: "Download", install: "Install", lead: "Lead", contact: "Message" };
const eventName = (name) => EVENT_NAMES[name] ?? name.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
const fromWhere = (c) => [c.source && c.source !== "Direct" ? `from ${c.source}` : "direct", [c.city, c.country ? countryName(c.country) : null].filter(Boolean).join(", ")].filter(Boolean).join(" · ");

// Momentum: five-minute bars above the line when visits beat the same time last week, below when they don't, and the
// sources attacking now against the half hour before.
function momentumView(m, { dark = false } = {}) {
  const W = 480, H = 120, mid = H / 2, gap = 3, bw = W / m.wave.length - gap;
  const most = Math.max(1, ...m.wave.map((b) => Math.abs(b.now - b.before)));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "wave", role: "img", "aria-label": "Visits in each five minutes of the last two hours, against the same time last week" });
  svg.append(svgEl("line", { x1: 0, x2: W, y1: mid, y2: mid, class: "axis" }));
  m.wave.forEach((b, i) => {
    const d = b.now - b.before, hgt = Math.max(d ? 3 : 1, (Math.abs(d) / most) * (mid - 6));
    const bar = svgEl("rect", { x: i * (bw + gap), y: d >= 0 ? mid - hgt : mid, width: bw, height: hgt, rx: 2, class: d > 0 ? "up" : d < 0 ? "down" : "even" });
    const tip = svgEl("title");
    tip.textContent = `${b.ago ? `${b.ago * 5}–${b.ago * 5 + 5} min ago` : "Last 5 min"}: ${b.now} new ${b.now === 1 ? "visit" : "visits"} (${b.before} a week ago)`;
    bar.append(tip);
    svg.append(bar);
  });
  const attackers = m.sources.length
    ? h("div", { class: "attackers" }, m.sources.slice(0, 6).map((s) => {
      const up = s.now > s.before, down = s.now < s.before;
      return h("div", { class: "attacker" }, h("span", { class: "who", text: s.source }), h("b", { text: int(s.now) }),
        h("span", { class: `trend ${up ? "up" : down ? "down" : ""}`, text: up ? `↑ ${s.now - s.before}` : down ? `↓ ${s.before - s.now}` : "=" }));
    }))
    : h("p", { class: dark ? "quiet" : "empty-note", text: "No one has arrived in the last hour." });
  return h("div", { class: "momentum" }, svg,
    h("div", { class: "wave-legend" }, h("span", { text: "2 hours ago" }), h("span", { text: "Above the line: more visits than the same time last week" }), h("span", { text: "Now" })),
    h("div", { class: "attackers-head" }, h("span", { text: "Attacking now" }), h("span", { text: "Last 30 min" })), attackers);
}

// The sound of a goal, made on the spot: a short rising horn over a swell of noise. Only after "Sound on".
let audio = null;
function cheer() {
  if (!audio) return;
  const t = audio.currentTime, out = audio.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
  out.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
  out.connect(audio.destination);
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "triangle";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + i * 0.12);
    g.gain.exponentialRampToValueAtTime(0.35, t + i * 0.12 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.9);
    o.connect(g).connect(out);
    o.start(t + i * 0.12);
    o.stop(t + i * 0.12 + 1);
  });
  const noise = audio.createBufferSource(), buf = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / ch.length);
  noise.buffer = buf;
  const band = audio.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 1400;
  const ng = audio.createGain();
  ng.gain.value = 0.25;
  noise.connect(band).connect(ng).connect(out);
  noise.start(t);
}

async function matchPage({ key = null, token = null }) {
  const base = token ? `/api/match/${token}` : `/api/sites/${key}/match`;
  const page = h("div", { class: "match" }, h("p", { class: "quiet", text: "Loading…" }));
  let data = null, last = 0, pending = null;
  const tiles = new Map();
  const clockEl = h("span", { class: "clock" });
  const tick = () => { clockEl.textContent = clock().slice(0, 5); };
  tick();
  every(10_000, tick);

  const load = async () => {
    last = Date.now();
    try {
      data = await api(base);
      draw();
    } catch (err) {
      if (!(err instanceof SignedOut)) page.replaceChildren(h("div", { class: "match-error" }, h("b", { text: err.message })));
    }
  };
  // Arrivals and departures nudge often; the scoreboard is asked again at most every ten seconds.
  const soon = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; load(); }, Math.max(0, 10_000 - (Date.now() - last)));
  };

  const goalsEl = h("b", { class: "big" }), nowEl = h("b", { class: "huge" }), visitorsEl = h("b", { class: "big" }), takingsEl = h("b", { class: "big money" });
  const field = pitch({ dark: true });
  const feed = h("ol", { class: "feed" });
  const overlay = h("div", { class: "goal-overlay", hidden: true });
  const line = (c) => h("li", { class: c.goal ? "goal" : c.kind === "number" ? "number" : "" },
    h("time", { text: clock(new Date(c.ts)).slice(0, 5) }),
    h("span", { class: "what" },
      c.goal ? h("b", { text: `GOAL · ${eventName(c.name)}` })
        : c.kind === "visit" ? h("span", { text: "New visitor" })
        : c.kind === "number" ? h("b", { text: `${c.name}: ${num(c.value)}` })
        : h("span", { text: eventName(c.name) }),
      c.kind === "number" ? null : h("span", { class: "where", text: ` ${fromWhere(c)}${c.path && c.kind === "visit" ? ` · ${c.path}` : ""}` })),
    c.revenue ? h("span", { class: "money", text: money(c.revenue.minor, c.revenue.currency) }) : null);

  function celebrate(c) {
    overlay.replaceChildren(h("div", { class: "goal-card" }, h("span", { class: "ball", text: "⚽" }), h("b", { text: "GOAL!" }),
      h("span", { text: `${eventName(c.name)}${c.revenue ? ` · ${money(c.revenue.minor, c.revenue.currency)}` : ""}` }), h("span", { class: "where", text: fromWhere(c) })),
      ...Array.from({ length: 36 }, (_, i) => h("i", { class: "confetti", style: { "--a": `${(i * 360) / 36}deg`, "--d": `${120 + ((i * 37) % 140)}px`, "--c": ["#29c46b", "#fff", "#ffd60a", "#4cc9f0"][i % 4] } })));
    overlay.hidden = false;
    overlay.classList.remove("play");
    void overlay.offsetWidth;
    overlay.classList.add("play");
    cheer();
    clearTimeout(celebrate.timer);
    celebrate.timer = setTimeout(() => { overlay.hidden = true; }, 4200);
  }

  function scoreboard() {
    const t = data.today;
    nowEl.textContent = int(data.now);
    visitorsEl.textContent = int(t.visitors);
    goalsEl.textContent = int(t.goals);
    takingsEl.textContent = t.takings.length ? t.takings.slice(0, 2).map((x) => money(x.minor, x.currency)).join(" + ") : "–";
  }

  function draw() {
    const d = data;
    scoreboard();
    field.sync(d.walkers ?? []);
    tiles.clear();
    const numbers = d.numbers.length ? h("div", { class: "match-numbers" }, d.numbers.slice(0, 8).map((n) => {
      const tile = numberTile(n, { big: true });
      tiles.set(n.name, tile);
      return tile;
    })) : null;
    feed.replaceChildren(...d.commentary.map(line));
    if (!d.commentary.length) feed.append(h("li", { class: "quiet", text: "Nothing yet today. Goals and new visitors appear here the moment they happen." }));
    const soundButton = h("button", { class: "btn ghost", type: "button", "aria-pressed": String(!!audio), onclick: async () => {
      if (audio) { await audio.close(); audio = null; } else { audio = new AudioContext(); cheer(); }
      soundButton.setAttribute("aria-pressed", String(!!audio));
      soundButton.replaceChildren(audio ? "Sound on" : "Sound off");
    } }, audio ? "Sound on" : "Sound off");
    const full = h("button", { class: "btn ghost", type: "button", text: "Full screen", onclick: () => (document.fullscreenElement ? document.exitFullscreen() : page.requestFullscreen?.()) });
    const share = key && state.sites?.find((s) => s.key === key)?.role === "owner" ? h("button", { class: "btn ghost", type: "button", text: "Share", onclick: () => shareMenu(share) }) : null;
    page.replaceChildren(
      h("header", { class: "match-top" },
        h("div", { class: "who" }, key ? siteIcon(state.sites.find((s) => s.key === key), 28) : null, h("b", { text: d.site.name }), h("span", { class: "live-pill" }, h("i", { class: "dot pulse" }), "LIVE")),
        clockEl,
        h("div", { class: "tools" }, soundButton, full, share, key ? h("a", { class: "btn ghost", href: `/sites/${key}/live`, "aria-label": "Leave the match view" }, icon("close", 16)) : null)),
      h("section", { class: "board" },
        h("div", { class: "stat now" }, h("span", { text: "On the site now" }), nowEl),
        h("div", { class: "stat" }, h("span", { text: "Visitors today" }), visitorsEl),
        h("div", { class: "stat" }, h("span", { text: "Goals today" }), goalsEl),
        h("div", { class: "stat" }, h("span", { text: "Takings today" }), takingsEl)),
      numbers,
      h("section", { class: "panel pitch-panel" }, h("h2", { text: "On the pitch: who's where, right now" }), field.el),
      h("section", { class: "match-main" },
        h("div", { class: "panel" }, h("h2", { text: "Momentum" }), momentumView(d.momentum, { dark: true })),
        h("div", { class: "panel" }, h("h2", { text: "Commentary" }), feed)),
      token ? h("footer", { class: "match-foot" }, h("a", { href: "/", "data-external": "" }, h("img", { src: LOGO, alt: "", width: 18, height: 18 }), "Live analytics by Statiku")) : null,
      overlay);
  }

  async function shareMenu(anchor) {
    const info = await api(`/api/sites/${key}`).catch(() => null);
    let url = info?.site.matchUrl ?? null;
    const box = h("div", { class: "share-box" });
    const paint = () => {
      const copyBtn = h("button", { class: "btn copy", type: "button", onclick: () => copy(url, copyBtn) }, icon("copy", 14), "Copy");
      box.replaceChildren(url
        ? h("div", { class: "form" }, h("b", { text: "Anyone with this link sees this scoreboard, and nothing else of the site." }), h("div", { class: "code-block small" }, url, copyBtn),
          h("button", { class: "btn", type: "button", text: "Turn the link off", onclick: async () => { url = (await api(`/api/sites/${key}/match/link`, { method: "DELETE" })).url; paint(); } }))
        : h("div", { class: "form" }, h("b", { text: "Share this scoreboard at a link of its own" }), h("span", { class: "muted", text: "For a launch day, a team channel or a TV. Only the scoreboard shows; you can turn the link off at any time." }),
          h("button", { class: "btn primary", type: "button", text: "Create a link", onclick: async () => { url = (await api(`/api/sites/${key}/match/link`, { method: "POST" })).url; paint(); } })));
    };
    paint();
    openPopover(anchor, [box], { align: "right", width: 360 });
  }

  const stream = new EventSource(token ? `${base}/stream` : `/api/sites/${key}/stream`);
  stream.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (!data) return;
    onPitch(field, msg);
    if (msg.t === "click") return;
    if (msg.t === "presence") return soon();
    if (msg.t === "number") {
      const tile = tiles.get(msg.n.name);
      if (tile) tile.update(msg.n.value, msg.n.ts);
      else soon();
      feed.prepend(line({ kind: "number", ts: msg.n.ts, name: msg.n.name, value: tile ? tile.data.value : msg.n.value }));
      return;
    }
    if (msg.t !== "event" || msg.e.name === "pageview" && !msg.e.first) return;
    const e = msg.e;
    const c = { ts: e.ts, kind: e.name === "pageview" ? "visit" : "event", name: e.name, path: e.path, source: e.source, country: e.country, city: e.city, revenue: e.revenue ?? null };
    c.goal = c.kind === "event" && (data.goals.includes(e.name) || !!c.revenue);
    feed.querySelector(".quiet")?.remove();
    feed.prepend(line(c));
    while (feed.children.length > 80) feed.lastChild.remove();
    if (c.goal) {
      data.today.goals += 1;
      if (c.revenue) {
        const same = data.today.takings.find((x) => x.currency === c.revenue.currency);
        if (same) same.minor += c.revenue.minor;
        else data.today.takings.push({ ...c.revenue });
      }
      scoreboard();
      celebrate(c);
    }
    soon();
  };
  onLeave(() => { stream.close(); clearTimeout(pending); });
  every(60_000, load);
  queueMicrotask(load);
  return page;
}

// ---------- Rendering ----------
const ROUTES = [
  [/^\/$/, () => ["home", null, homePage()]],
  [/^\/settings$/, () => ["account", null, accountPage()]],
  [/^\/plan$/, () => ["plan", null, planPage()]],
  [/^\/sites\/new$/, () => ["add", null, addSitePage()]],
  [/^\/sites\/(p_[a-z0-9]+)$/, (k) => ["analytics", k, analyticsPage(k)]],
  [/^\/sites\/(p_[a-z0-9]+)\/live$/, (k) => ["live", k, livePage(k)]],
  [/^\/sites\/(p_[a-z0-9]+)\/setup$/, (k) => ["setup", k, setupPage(k)]],
  [/^\/sites\/(p_[a-z0-9]+)\/settings$/, (k) => ["settings", k, siteSettingsPage(k)]],
  [/^\/sites\/(p_[a-z0-9]+)\/import$/, (k) => ["import", k, importPage(k)]],
  [/^\/trackers$/, () => ["trackers", null, trackersPage()]],
  [/^\/trackers\/new$/, () => ["addTracker", null, addTrackerPage()]],
  [/^\/sites\/(p_[a-z0-9]+)\/numbers$/, (k) => ["addTracker", null, addTrackerPage(k)]],
  [/^\/sites\/(p_[a-z0-9]+)\/heatmaps$/, (k) => ["heatmaps", k, heatmapsPage(k)]],
];
const TITLES = { home: "Websites", account: "Settings", plan: "Plan", add: "Add a website", analytics: "Analytics", live: "Live view", setup: "Setup", settings: "Site settings", import: "Import history", trackers: "Trackers", addTracker: "Add a tracker", heatmaps: "Heatmaps" };

let rendering = 0;
async function render() {
  const run = ++rendering;
  for (const fn of leaving.splice(0)) fn();
  closePopover();
  const root = $("app");
  const path = location.pathname;
  const auth = path === "/login" || path === "/signup";
  const join = path.match(/^\/join\/([\w-]{20,80})$/);
  const reset = path.match(/^\/reset\/([\w-]{20,80})$/);
  const sharedMatch = path.match(/^\/m\/([\w-]{20,40})$/);
  const ownMatch = path.match(/^\/sites\/(p_[a-z0-9]+)\/match$/);
  try {
    if (sharedMatch) {
      const content = await matchPage({ token: sharedMatch[1] });
      if (run === rendering) root.replaceChildren(content);
      document.title = "Live · Statiku";
      return;
    }
    if (state.user === undefined) {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      const me = res.ok ? await res.json() : null;
      state.user = me?.user ?? null;
      state.billing = me?.billing ?? null;
    }
    if (run !== rendering) return;
    if (join) {
      document.title = "Join a team · Statiku";
      const content = await joinPage(join[1]);
      if (run === rendering) root.replaceChildren(content);
      return;
    }
    if (reset || path === "/forgot") {
      document.title = "Choose a new password · Statiku";
      const content = reset ? await resetPage(reset[1]) : forgotPage();
      if (run === rendering) root.replaceChildren(content);
      return;
    }
    if (!state.user && !auth) return go(`/login${path === "/" ? "" : `?next=${encodeURIComponent(path)}`}`, true);
    if (state.user && auth) return go("/", true);
    if (auth) {
      document.title = path === "/signup" ? "Create your account · Statiku" : "Sign in · Statiku";
      return root.replaceChildren(authPage(path === "/signup" ? "signup" : "login"));
    }
    await loadSites();
    if (ownMatch) {
      const site = state.sites.find((s) => s.key === ownMatch[1]);
      if (!site) return go("/", true);
      const content = await matchPage({ key: site.key });
      if (run === rendering) root.replaceChildren(content);
      document.title = `Match view · ${site.name} · Statiku`;
      return;
    }
    const route = ROUTES.find(([re]) => re.test(path));
    if (!route) return go("/", true);
    const key = path.match(route[0])[1];
    if (key && !state.sites.some((s) => s.key === key)) return go("/", true);
    const [active, siteKey, pending] = route[1](key);
    const site = state.sites.find((s) => s.key === siteKey) ?? null;
    root.replaceChildren(...shell(site, active, h("div", { class: "page" }, h("p", { class: "muted", text: "Loading…" }))));
    const content = await pending;
    if (run !== rendering) return;
    $("main").replaceChildren(...[billingBanner(), content].filter(Boolean));
    document.title = `${TITLES[active]}${site ? ` · ${site.name}` : ""} · Statiku`;
    if (!location.hash) window.scrollTo(0, 0);
  } catch (err) {
    if (err instanceof SignedOut || run !== rendering) return;
    const main = $("main") ?? root;
    main.replaceChildren(h("div", { class: "page" }, failure(err)));
  }
}

render();
