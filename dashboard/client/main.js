// Statiku's dashboard: one page app. Signed out it shows sign-in, sign-up and invitations; signed in, the websites,
// and for each one its analytics, a live view with a globe, the steps to add it to the site, and its settings, plus
// the account's own settings and team. Everything shown comes from /api, and everything from the server goes into
// the page as text.
import { lineChart, minuteBars, sparkline } from "./charts.js";
import { createGlobe } from "./globe.js";

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
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
  websites: '<rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2"/><path d="M2.75 7.5h14.5"/><path d="M5.25 5.6h.01M7.25 5.6h.01M9.25 5.6h.01" stroke-width="1.9"/>',
  chart: '<path d="M4 16.5v-4M8 16.5v-8M12 16.5v-6M16 16.5V4"/>',
  live: '<circle cx="10" cy="10" r="1.8"/><path d="M6.8 13.2a4.5 4.5 0 0 1 0-6.4M13.2 6.8a4.5 4.5 0 0 1 0 6.4M4.3 15.7a8 8 0 0 1 0-11.4M15.7 4.3a8 8 0 0 1 0 11.4"/>',
  code: '<path d="m7 6-4 4 4 4M13 6l4 4-4 4"/>',
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
  download: '<path d="M10 3.5v9M6.3 9l3.7 3.7L13.7 9M4 16.5h12"/>',
  export: '<path d="M10 12.5v-9M6.3 7.2 10 3.5l3.7 3.7M4 12v3.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V12"/>',
  cart: '<path d="M3 4h2l1.6 8.2a1 1 0 0 0 1 .8h6.6a1 1 0 0 0 1-.8L16.5 7H6"/><circle cx="8.5" cy="16" r="1"/><circle cx="14" cy="16" r="1"/>',
  spark: '<path d="M10 3.5v3M10 13.5v3M3.5 10h3M13.5 10h3M5.4 5.4l2.1 2.1M12.5 12.5l2.1 2.1M5.4 14.6l2.1-2.1M12.5 7.5l2.1-2.1"/>',
  app: '<rect x="3" y="4" width="14" height="10" rx="1.8"/><path d="M7.5 16.5h5M10 14v2.5"/>',
  logout: '<path d="M8 16.5H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h3M12.5 13.5 16 10l-3.5-3.5M16 10H8"/>',
  trash: '<path d="M4 6h12M8 6V4.5h4V6M5.5 6l.7 10a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-10"/>',
};
function icon(name, size = 18) {
  const t = document.createElement("template");
  t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstChild;
}

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
function photo(user, size = 32) {
  const box = h("span", { class: "photo", style: { width: `${size}px`, height: `${size}px` } });
  if (user?.photo) box.append(h("img", { src: `/api/me/photo?v=${user.photo}`, alt: "" }));
  else box.append(icon("person", Math.round(size * 0.62)));
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
  metric: "visitors", appMetric: "installs", filters: { ...NO_FILTERS }, pagesTab: "top", table: false,
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
  }, state.user.photo ? h("img", { src: `/api/me/photo?v=${state.user.photo}`, alt: "" }) : icon("person", 18));

  const topbar = h("header", { class: "topbar" },
    h("button", { class: "menu-button", type: "button", "aria-label": "Menu", "aria-controls": "sidebar", onclick: () => toggleMenu(!sidebar.classList.contains("open")) }, icon("menu", 22)),
    h("a", { class: "brand", href: "/" }, h("img", { src: "/favicon.svg", alt: "" }), h("span", { text: "Statiku" })),
    h("div", { class: "center" }, switcher),
    h("div", { class: "actions" }, avatar));

  // Settings sits at the foot: a site's own inside a site, the account's everywhere else.
  sidebar.append(
    h("nav", { "aria-label": "Main" },
      navItem("/", "websites", "Websites", active === "home"),
      navItem("/sites/new", "plus", "Add website", active === "add"),
      site ? [
        h("div", { class: "nav-label" }, siteIcon(site, 16), h("span", { text: site.domains[0] })),
        navItem(`/sites/${site.key}`, "chart", "Analytics", active === "analytics"),
        navItem(`/sites/${site.key}/live`, "live", "Live view", active === "live",
          h("span", { class: "count", id: "nav-live", hidden: !site.live }, h("i", { class: "dot pulse" }), h("span", { text: String(site.live) }))),
        navItem(`/sites/${site.key}/setup`, "code", "Setup", active === "setup"),
      ] : null),
    h("div", { class: "foot" }, site
      ? navItem(`/sites/${site.key}/settings`, "settings", "Settings", active === "settings")
      : navItem("/settings", "settings", "Settings", active === "account")));

  return [topbar, sidebar, overlay, h("main", { class: "main", id: "main" }, content)];
}

function pageHead(titleParts, tools) {
  return h("div", { class: "page-head" }, h("div", { class: "title" }, titleParts), tools ? h("div", { class: "tools" }, tools) : null);
}
const failure = (e) => h("div", { class: "error", role: "alert", text: e.message || String(e) });
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
    return h("div", { class: "field" }, h("label", { for: id, text: label }),
      h("input", { class: "input big", id, name, type, autocomplete, required: true }),
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
    h("div", { class: "logo" }, h("img", { src: "/favicon.svg", alt: "" }), "Statiku"), kids,
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
      authForm(mode, { onDone: () => go(safeNext ?? (signup ? "/sites/new" : "/"), true) })),
    h("p", { class: "switch" }, signup ? "Already have an account? " : "New to Statiku? ",
      h("a", { href: `${signup ? "/login" : "/signup"}${safeNext ? `?next=${encodeURIComponent(safeNext)}` : ""}`, text: signup ? "Sign in" : "Create an account" })));
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
      h("button", { type: "button", "aria-pressed": String(i === platform), text: name, onclick: () => { platform = i; drawPlatform(); } })));
    const [name, note, list] = PLATFORMS[platform];
    steps.replaceChildren(h("p", { class: "muted", text: `${name}: ${note}.` }), h("ol", { class: "how" }, list.map((s) => h("li", {}, h("span", {}, rich(s))))));
  };
  drawPlatform();
  const mail = `mailto:?subject=${encodeURIComponent(`Add Statiku analytics to ${domain}`)}&body=${encodeURIComponent(
    `Hi,\n\nCould you add Statiku analytics to ${domain}? It's one line, to paste just before </head> on every page:\n\n${snippet}\n\nIt sets no cookies and is under 2 KB, so it won't slow the site down.\n\nThanks!`)}`;

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
          h("p", { class: "muted", text: "It's under 2 KB, sets no cookies and needs no consent banner. Add it to every page you want to count." }))),
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
];
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
  const body = h("div", {}, h("p", { class: "muted", text: "Loading…" }));
  const refreshed = h("span", { class: "muted" });
  const rangeButton = h("button", { class: "btn", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" });
  const liveButton = h("a", { class: "btn", href: `/sites/${key}/live` });
  const exportButton = h("button", { class: "btn", type: "button", disabled: true, onclick: () => data && exportCsv(data) }, icon("export", 16), "Export");
  const chips = h("div", { class: "filters", hidden: true });
  let data = null;

  const rangeLabel = () => (state.range === "custom" && state.from && state.to
    ? `${day(`${state.from}T12:00`)} – ${day(`${state.to}T12:00`)}`
    : RANGES.find(([id]) => id === state.range)?.[1] ?? "Last 30 days");

  const drawTools = () => {
    rangeButton.replaceChildren(icon("calendar", 16), rangeLabel(), icon("down", 14));
    rangeButton.onclick = () => {
      const today = new Date().toISOString().slice(0, 10);
      const fromInput = h("input", { class: "input", type: "date", required: true, max: today, value: state.from ?? new Date(Date.now() - 13 * 86400_000).toISOString().slice(0, 10) });
      const toInput = h("input", { class: "input", type: "date", required: true, max: today, value: state.to ?? today });
      openPopover(rangeButton, [
        ...RANGES.map(([id, label]) => menuItem([label, id === state.range ? h("span", { class: "end" }, icon("check", 16)) : null],
          () => { state.range = id; remember(); load(); }, { role: "menuitemradio", "aria-checked": String(id === state.range) })),
        h("form", {
          class: "custom-range",
          onsubmit: (e) => {
            e.preventDefault();
            if (!fromInput.value || !toInput.value) return;
            [state.from, state.to] = [fromInput.value, toInput.value].sort();
            state.range = "custom";
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
      for (const [f, v] of Object.entries(state.filters)) if (v) q.set(f, v);
      data = await api(`/api/sites/${key}/stats?${q}`);
      refreshed.textContent = `Last refreshed ${clock().slice(0, 5)}`;
      exportButton.disabled = false;
      draw();
    } catch (err) {
      if (!(err instanceof SignedOut)) body.replaceChildren(failure(err));
    }
  }
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
    if (!d.lastEventAt) {
      body.replaceChildren(h("div", { class: "card status-card" }, h("span", { class: "icon wait" }, icon("wait", 22)),
        h("div", { class: "what" }, h("b", { text: "No visits yet" }), h("span", { class: "muted", text: "Add the tracking code to your site, and your first visitors show here and in the live view." })),
        h("a", { class: "btn primary", href: `/sites/${key}/setup` }, "Finish setup")));
      return;
    }
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
    tableHost.append(h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: unit === "hour" ? "Hour" : unit === "month" ? "Month" : "Day" }), h("th", { text: m.label }), h("th", { text: "Previous period" }))),
      h("tbody", {}, points.map((p, i) => h("tr", {}, h("td", { text: p.label }), h("td", { text: m.fmt(p.v) }), h("td", { text: compare[i] ? m.fmt(compare[i].v) : "–" }))).reverse())));
    const chartCard = h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h2", { text: `${m.label} over time` }), h("span", { class: "sub", text: unit === "hour" ? "by hour" : unit === "month" ? "by month" : "by day" }), h("div", { class: "end" }, toggle)),
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
      kpis,
      h("div", { class: "grid g-side" }, chartCard, breakdown),
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
    lineChart(chartHost, points, compare, m, { current: spanName(d.range.from, d.range.to), previous: spanName(d.range.prevFrom, d.range.prevTo) });
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
  const globeCard = h("div", { class: "card globe-card" }, canvas,
    h("div", { class: "over" }, h("b", { text: "Visitors right now" }), overCount), caption, tip);
  const locations = h("div"), pages = h("div"), perMinute = h("div", { class: "chart" }), sources = h("div"), feed = h("div", { class: "feed" });
  let latest = null;

  const globe = createGlobe(canvas, {
    onHover: (dot, x, y) => {
      if (!dot) return void (tip.hidden = true);
      tip.replaceChildren(h("b", {}, `${flag(dot.code)} ${countryName(dot.code)}`), h("span", { class: "muted", text: `${dot.v} ${dot.v === 1 ? "visitor" : "visitors"} now` }));
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
      tip.hidden = false;
    },
  });
  onLeave(() => globe.destroy());

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
    globe.update(d.countries);
    overCount.textContent = d.visitors ? `${d.visitors} in ${d.countries.length} ${d.countries.length === 1 ? "country" : "countries"}` : "";
    canvas.setAttribute("aria-label", d.visitors ? `Visitors right now: ${d.countries.map((c) => `${c.v} in ${countryName(c.label)}`).join(", ")}` : "No visitors right now");
    caption.textContent = d.visitors ? "Each dot is a country with visitors right now. Drag to turn the globe." : "No one's on the site right now. New visitors appear the moment they arrive.";
    locations.replaceChildren(bars(d.countries, {
      head: ["Country", "Visitors"], label: (r) => countryName(r.label), lead: (r) => h("span", { class: "flag", text: flag(r.label) }),
      onPick: (r) => globe.focus(r.label), canPick: (r) => r.label !== "Unknown",
    }));
    pages.replaceChildren(bars(d.pages, { head: ["Page", "Visitors"] }));
    sources.replaceChildren(bars(d.sources, { head: ["Source", "Visitors"] }));
    minuteBars(perMinute, d.perMinute, (v) => `${v} ${v === 1 ? "page view" : "page views"}`);
    drawFeed();
  }

  // A safety net for anything the stream can't say, such as a laptop closed without a goodbye.
  every(10_000, load);
  queueMicrotask(load);

  return h("div", { class: "page" },
    pageHead([icon("live", 20), h("h1", { text: "Live view" }), connection, h("span", { class: "muted", text: site?.domains[0] }), updated],
      h("a", { class: "btn", href: `/sites/${key}` }, icon("chart", 16), "Analytics")),
    kpis,
    h("div", { class: "grid g-globe" }, globeCard,
      h("div", { class: "stack" }, card("Top locations", locations, { sub: "Click to find one on the globe" }), card("Pages being viewed", pages))),
    h("div", { class: "grid g3" },
      card("Page views per minute", perMinute, { sub: "Last 30 minutes" }),
      card("Sources right now", sources),
      card("Recent activity", feed, { sub: "Last 30 minutes" })));
}

// ---------- A site's settings ----------
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
      h("div", { style: { marginTop: "8px" } }, t.members.map((m) => h("div", { class: "person-row" }, photo(m.you ? state.user : null, 32),
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
  h("div", { class: "field" }, h("label", { for: "p-current", text: "Current password" }), current),
  h("div", { class: "field" }, h("label", { for: "p-next", text: "New password" }), next, h("span", { class: "help", text: "At least 8 characters." })),
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
  h("div", { class: "field" }, h("label", { for: "d-password", text: "Your password" }), closePassword),
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

// ---------- Rendering ----------
const ROUTES = [
  [/^\/$/, () => ["home", null, homePage()]],
  [/^\/settings$/, () => ["account", null, accountPage()]],
  [/^\/sites\/new$/, () => ["add", null, addSitePage()]],
  [/^\/sites\/(p_[a-z0-9]+)$/, (k) => ["analytics", k, analyticsPage(k)]],
  [/^\/sites\/(p_[a-z0-9]+)\/live$/, (k) => ["live", k, livePage(k)]],
  [/^\/sites\/(p_[a-z0-9]+)\/setup$/, (k) => ["setup", k, setupPage(k)]],
  [/^\/sites\/(p_[a-z0-9]+)\/settings$/, (k) => ["settings", k, siteSettingsPage(k)]],
];
const TITLES = { home: "Websites", account: "Settings", add: "Add a website", analytics: "Analytics", live: "Live view", setup: "Setup", settings: "Site settings" };

let rendering = 0;
async function render() {
  const run = ++rendering;
  for (const fn of leaving.splice(0)) fn();
  closePopover();
  const root = $("app");
  const path = location.pathname;
  const auth = path === "/login" || path === "/signup";
  const join = path.match(/^\/join\/([\w-]{20,80})$/);
  try {
    if (state.user === undefined) {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      state.user = res.ok ? (await res.json()).user : null;
    }
    if (run !== rendering) return;
    if (join) {
      document.title = "Join a team · Statiku";
      const content = await joinPage(join[1]);
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
    const route = ROUTES.find(([re]) => re.test(path));
    if (!route) return go("/", true);
    const key = path.match(route[0])[1];
    if (key && !state.sites.some((s) => s.key === key)) return go("/", true);
    const [active, siteKey, pending] = route[1](key);
    const site = state.sites.find((s) => s.key === siteKey) ?? null;
    root.replaceChildren(...shell(site, active, h("div", { class: "page" }, h("p", { class: "muted", text: "Loading…" }))));
    const content = await pending;
    if (run !== rendering) return;
    $("main").replaceChildren(content);
    document.title = `${TITLES[active]}${site ? ` · ${site.name}` : ""} · Statiku`;
    if (!location.hash) window.scrollTo(0, 0);
  } catch (err) {
    if (err instanceof SignedOut || run !== rendering) return;
    const main = $("main") ?? root;
    main.replaceChildren(h("div", { class: "page" }, failure(err)));
  }
}

render();
