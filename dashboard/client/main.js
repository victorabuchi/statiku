// Statiku's dashboard: one page app. Signed out it shows sign-in and sign-up; signed in, the websites, and for each
// one its analytics, a live view with a globe, the steps to add it to the site, and its settings. Everything shown
// comes from /api, and everything from the server goes into the page as text.
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
  home: '<path d="M3.5 9 10 4l6.5 5v7a1 1 0 0 1-1 1H12v-4.5H8V17H4.5a1 1 0 0 1-1-1V9Z"/>',
  chart: '<path d="M4 16.5v-4M8 16.5v-8M12 16.5v-6M16 16.5V4"/>',
  live: '<circle cx="10" cy="10" r="1.8"/><path d="M6.8 13.2a4.5 4.5 0 0 1 0-6.4M13.2 6.8a4.5 4.5 0 0 1 0 6.4M4.3 15.7a8 8 0 0 1 0-11.4M15.7 4.3a8 8 0 0 1 0 11.4"/>',
  code: '<path d="m7 6-4 4 4 4M13 6l4 4-4 4"/>',
  settings: '<path d="M4 6.5h7M15.5 6.5H16M4 13.5h.5M9 13.5h7"/><circle cx="13.25" cy="6.5" r="2"/><circle cx="6.75" cy="13.5" r="2"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  down: '<path d="m6 8 4 4 4-4"/>',
  calendar: '<rect x="3.5" y="4.5" width="13" height="12" rx="2"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/>',
  close: '<path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/>',
  menu: '<path d="M3.5 6h13M3.5 10h13M3.5 14h13"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  back: '<path d="M12 15 7 10l5-5"/>',
  globe: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c1.9 2.1 2.9 4.4 2.9 7s-1 4.9-2.9 7c-1.9-2.1-2.9-4.4-2.9-7s1-4.9 2.9-7Z"/>',
  copy: '<rect x="7" y="7" width="9.5" height="9.5" rx="2"/><path d="M13 7V5.5A2 2 0 0 0 11 3.5H5.5a2 2 0 0 0-2 2V11a2 2 0 0 0 2 2H7"/>',
  external: '<path d="M11.5 3.5h5v5M16.5 3.5 9 11M14 12v3.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H8"/>',
  mail: '<rect x="3" y="5" width="14" height="10.5" rx="2"/><path d="m3.5 6 6.5 5 6.5-5"/>',
  wait: '<circle cx="10" cy="10" r="7"/><path d="M10 6.3V10l2.5 1.8"/>',
  eye: '<path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z"/><circle cx="10" cy="10" r="2.2"/>',
  download: '<path d="M10 3.5v9M6.3 9l3.7 3.7L13.7 9M4 16.5h12"/>',
  cart: '<path d="M3 4h2l1.6 8.2a1 1 0 0 0 1 .8h6.6a1 1 0 0 0 1-.8L16.5 7H6"/><circle cx="8.5" cy="16" r="1"/><circle cx="14" cy="16" r="1"/>',
  spark: '<path d="M10 3.5v3M10 13.5v3M3.5 10h3M13.5 10h3M5.4 5.4l2.1 2.1M12.5 12.5l2.1 2.1M5.4 14.6l2.1-2.1M12.5 7.5l2.1-2.1"/>',
  app: '<rect x="3" y="4" width="14" height="10" rx="1.8"/><path d="M7.5 16.5h5M10 14v2.5"/>',
  logout: '<path d="M8 16.5H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h3M12.5 13.5 16 10l-3.5-3.5M16 10H8"/>',
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
const clock = (d = new Date()) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const LETTERS = ["#2a78d6", "#008060", "#6250d6", "#eb6834", "#d55181", "#1baf7a", "#c98500", "#e34948"];
function letter(site, size = 32) {
  const name = site.name || site.domains?.[0] || "?";
  let hash = 0;
  for (const ch of site.domains?.[0] ?? name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return h("span", { class: "letter", style: { background: LETTERS[hash % LETTERS.length], width: `${size}px`, height: `${size}px` }, "aria-hidden": "true", text: name.trim()[0]?.toUpperCase() ?? "?" });
}
// `text` with code spans: "Paste it before `</head>`."
const rich = (text) => text.split("`").map((part, i) => (i % 2 ? h("code", { text: part }) : part));

function toast(message) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status", text: message });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
    if (button) {
      const before = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = before), 1600);
    }
  } catch {
    toast("Couldn't copy. Select the text and copy it yourself.");
  }
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
  if (res.status === 401 && !path.startsWith("/api/login")) {
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
const state = { user: undefined, sites: null, range: saved.range ?? "d30", metric: "visitors", appMetric: "installs", source: null, pagesTab: "top", table: false };
const remember = () => {
  try {
    localStorage.setItem("statiku", JSON.stringify({ range: state.range }));
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
  if (!a || a.target || a.hasAttribute("data-external") || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(a.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.preventDefault();
  go(url.pathname + url.search);
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
  node.querySelector("button, a")?.focus();
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
        letter(s, 22), h("span", {}, h("span", { text: s.name })), s.live ? h("span", { class: "end live-pill" }, h("i", { class: "dot pulse" }), s.live) : null)),
      state.sites.length ? h("hr") : null,
      h("a", { class: "item", href: "/", onclick: closePopover }, icon("home"), "All websites"),
      h("a", { class: "item", href: "/sites/new", onclick: closePopover }, icon("plus"), "Add website"),
    ]),
  }, site ? letter(site, 22) : icon("globe"), h("span", { class: "site-name", text: site ? site.name : "All websites" }),
    site && site.name !== site.domains[0] ? h("span", { class: "site-domain", text: site.domains[0] }) : null, icon("down", 16));

  const initials = state.user.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const avatar = h("button", {
    class: "avatar", type: "button", "aria-label": `Account: ${state.user.name}`, "aria-haspopup": "menu", "aria-expanded": "false", text: initials,
    onclick: () => openPopover(avatar, [
      h("div", { class: "who" }, h("b", { text: state.user.name }), h("span", { class: "muted", text: state.user.email })),
      menuItem([icon("logout"), "Sign out"], async () => {
        await api("/api/logout", { method: "POST" }).catch(() => {});
        state.user = null;
        state.sites = null;
        go("/login", true);
      }),
    ], { align: "right", width: 260 }),
  });

  const topbar = h("header", { class: "topbar" },
    h("button", { class: "menu-button", type: "button", "aria-label": "Menu", "aria-controls": "sidebar", onclick: () => toggleMenu(!sidebar.classList.contains("open")) }, icon("menu", 22)),
    h("a", { class: "brand", href: "/" }, h("img", { src: "/favicon.svg", alt: "" }), h("span", { text: "Statiku" })),
    h("div", { class: "center" }, switcher),
    h("div", { class: "actions" }, avatar));

  sidebar.append(
    h("nav", { "aria-label": "Main" },
      navItem("/", "home", "Websites", active === "home"),
      site ? [
        h("div", { class: "nav-label", text: site.domains[0] }),
        navItem(`/sites/${site.key}`, "chart", "Analytics", active === "analytics"),
        navItem(`/sites/${site.key}/live`, "live", "Live view", active === "live", site.live ? h("span", { class: "count" }, h("i", { class: "dot pulse" }), site.live) : null),
        navItem(`/sites/${site.key}/setup`, "code", "Setup", active === "setup"),
        navItem(`/sites/${site.key}/settings`, "settings", "Settings", active === "settings"),
      ] : null),
    h("div", { class: "foot" }, navItem("/sites/new", "plus", "Add website", active === "add")));

  return [topbar, sidebar, overlay, h("main", { class: "main", id: "main" }, content)];
}

function pageHead(titleParts, tools) {
  return h("div", { class: "page-head" }, h("div", { class: "title" }, titleParts), tools ? h("div", { class: "tools" }, tools) : null);
}
const failure = (e) => h("div", { class: "error", role: "alert", text: e.message || String(e) });

// ---------- Sign in and sign up ----------
function authPage(mode) {
  const signup = mode === "signup";
  const next = new URLSearchParams(location.search).get("next");
  const error = h("div", { class: "error", role: "alert", hidden: true });
  const field = (label, name, type, autocomplete, help) => {
    const id = `f-${name}`;
    return h("div", { class: "field" }, h("label", { for: id, text: label }),
      h("input", { class: "input big", id, name, type, autocomplete, required: true, ...(name === "password" ? { minlength: signup ? "8" : null } : {}) }),
      help ? h("span", { class: "help", text: help }) : null);
  };
  const button = h("button", { class: "btn primary big", type: "submit", text: signup ? "Create account" : "Sign in" });
  const form = h("form", {
    class: "form", novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      button.disabled = true;
      error.hidden = true;
      try {
        const { user } = await api(signup ? "/api/signup" : "/api/login", { method: "POST", body: data });
        state.user = user;
        state.sites = null;
        go(next && next.startsWith("/") && !next.startsWith("//") ? next : signup ? "/sites/new" : "/", true);
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
  return h("div", { class: "auth" }, h("div", { class: "box" },
    h("div", { class: "logo" }, h("img", { src: "/favicon.svg", alt: "" }), "Statiku"),
    h("div", { class: "card" },
      h("div", {}, h("h1", { text: signup ? "Create your account" : "Sign in" }),
        h("p", { class: "sub", text: signup ? "Add your website and see your visitors in minutes. No credit card." : "See who's visiting your websites." })),
      form),
    h("p", { class: "switch" }, signup ? "Already have an account? " : "New to Statiku? ",
      h("a", { href: signup ? "/login" : "/signup", text: signup ? "Sign in" : "Create an account" })),
    h("p", { class: "promise" }, h("span", { text: "No cookies on your visitors" }), h("span", { text: "No IP addresses stored" }), h("span", { text: "Data kept in the EU" }))));
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
    list.replaceChildren(h("div", { class: "sites" }, state.sites.map(siteCard)));
  };
  draw();
  every(30_000, async () => {
    await loadSites(true);
    draw();
  });
  return h("div", { class: "page" },
    pageHead([icon("home", 20), h("h1", { text: "Websites" }), sites.length ? h("span", { class: "muted", text: `${sites.length} ${sites.length === 1 ? "site" : "sites"}` }) : null],
      sites.length ? h("a", { class: "btn primary", href: "/sites/new" }, icon("plus", 16), "Add website") : null),
    list);
}

function siteCard(s) {
  const ready = !!s.lastEventAt;
  return h("a", { class: "card site-card", href: ready ? `/sites/${s.key}` : `/sites/${s.key}/setup` },
    h("div", { class: "top" }, letter(s), h("div", { class: "who" }, h("b", { text: s.name }), s.name !== s.domains[0] ? h("span", { text: s.domains[0] }) : null),
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
      ["3. Watch visitors arrive", "See them on the live globe within seconds, then where they came from and what they read."]]
      .map(([title, text]) => h("div", {}, h("b", { text: title }), h("span", { class: "muted", text })))));
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
  const zones = (() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [zone];
    }
  })();
  const tz = h("select", { class: "input", id: "f-zone", name: "timezone" }, zones.map((z) => h("option", { value: z, text: z.replaceAll("_", " "), selected: z === zone })));
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
        h("span", { class: "muted", text: `Once the code is on your site, open ${domain} in your browser. This turns green within seconds.` })),
      h("a", { class: "btn", href: `https://${domain}`, target: "_blank", rel: "noopener", "data-external": "" }, `Open ${domain}`, icon("external", 14))]));
  drawStatus();
  // Quick while waiting for the first visit, then now and then.
  let since = 0;
  every(4000, async () => {
    if (lastEventAt && (since += 4000) < 30_000) return;
    since = 0;
    const fresh = await api(`/api/sites/${key}`).catch(() => null);
    if (fresh && fresh.site.lastEventAt !== lastEventAt) {
      const first = !lastEventAt;
      lastEventAt = fresh.site.lastEventAt;
      drawStatus();
      if (first) {
        toast(`First visit received from ${domain}`);
        state.sites = null;
      }
    }
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
  { id: "perVisit", label: "Views per visit", fmt: (n) => (n == null ? "–" : n.toFixed(2)), tick: (n) => n.toFixed(1), derived: true },
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
  const day = new Date(y, mo - 1, d);
  if (unit === "hour") return long ? `${day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}` : time;
  if (unit === "month") return day.toLocaleDateString("en-US", { month: "short", year: long ? "numeric" : undefined });
  return day.toLocaleDateString("en-US", { month: "short", day: "numeric", year: long ? "numeric" : undefined });
}
function spanName(from, to) {
  const a = new Date(from), b = new Date(new Date(to).getTime() - 1);
  const opts = { month: "short", day: "numeric", year: "numeric" };
  return a.toDateString() === b.toDateString() ? a.toLocaleDateString("en-US", opts) : `${a.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${b.toLocaleDateString("en-US", opts)}`;
}

function bars(rows, { head, fmt = int, onPick, canPick = () => true, label = (r) => r.label, lead } = {}) {
  if (!rows.length) return h("p", { class: "empty-note", text: "No data for this period" });
  const max = Math.max(...rows.map((r) => r.v), 1);
  const total = rows.reduce((a, r) => a + r.v, 0);
  return h("div", { class: "bars" },
    head ? h("div", { class: "bars-head" }, h("span", { text: head[0] }), h("span", { text: head[1] })) : null,
    rows.map((r) => {
      const pickable = onPick && canPick(r);
      return h(pickable ? "button" : "div", {
        class: `bar-row${r.label === state.source && pickable ? " on" : ""}`, type: pickable ? "button" : null,
        onclick: pickable ? () => onPick(r) : null,
      }, h("span", { class: "wash", style: { width: `${(100 * r.v) / max}%` } }),
        h("span", { class: "l" }, lead?.(r), h("span", { text: label(r) })),
        h("span", { class: "r" }, fmt(r.v), h("small", { text: pct(r.v, total, 0) })));
    }));
}

function card(title, body, { sub, end } = {}) {
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: title }), sub ? h("span", { class: "sub", text: sub }) : null, end ? h("div", { class: "end" }, end) : null),
    h("div", { class: "card-body" }, body));
}

function tabs(items, current, pick) {
  return h("div", { class: "tabs", role: "tablist" }, items.map(([id, label]) =>
    h("button", { type: "button", role: "tab", "aria-selected": String(id === current), text: label, onclick: () => pick(id) })));
}

async function analyticsPage(key) {
  const site = state.sites.find((s) => s.key === key);
  const body = h("div", {}, h("p", { class: "muted", text: "Loading…" }));
  const refreshed = h("span", { class: "muted" });
  const rangeButton = h("button", { class: "btn", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" });
  const liveButton = h("a", { class: "btn", href: `/sites/${key}/live` });
  const filter = h("span");
  let data = null;

  const drawTools = () => {
    rangeButton.replaceChildren(icon("calendar", 16), RANGES.find(([id]) => id === state.range)?.[1] ?? "Last 30 days", icon("down", 14));
    rangeButton.onclick = () => openPopover(rangeButton, RANGES.map(([id, label]) =>
      menuItem([label, id === state.range ? h("span", { class: "end" }, icon("check", 16)) : null], () => { state.range = id; remember(); load(); }, { role: "menuitemradio", "aria-checked": String(id === state.range) })));
    const live = state.sites.find((s) => s.key === key)?.live ?? 0;
    liveButton.replaceChildren(h("i", { class: `dot${live ? " pulse" : " idle"}` }), live ? `${live} ${live === 1 ? "visitor" : "visitors"} now` : "Live view");
    filter.replaceChildren(state.source
      ? h("span", { class: "chip" }, "Source: ", h("b", { text: state.source }), h("button", { type: "button", "aria-label": "Clear the source filter", onclick: () => { state.source = null; load(); } }, icon("close", 14)))
      : "");
  };

  async function load() {
    drawTools();
    try {
      const q = new URLSearchParams({ range: state.range });
      if (state.source) q.set("source", state.source);
      data = await api(`/api/sites/${key}/stats?${q}`);
      refreshed.textContent = `Last refreshed ${clock()}`;
      draw();
    } catch (err) {
      if (!(err instanceof SignedOut)) body.replaceChildren(failure(err));
    }
  }
  const pickSource = (name) => {
    state.source = state.source === name ? null : name;
    window.scrollTo({ top: 0, behavior: "smooth" });
    load();
  };

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
      h("div", { class: "card-head" }, h("h2", { text: `${m.label} over time` }), h("span", { class: "sub", text: RANGES.find(([id]) => id === d.range.id)?.[2] }), h("div", { class: "end" }, toggle)),
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
        card("Top sources", bars(d.sources, { head: ["Source", "Visitors"], onPick: (r) => pickSource(r.label) }), { sub: "Click one to filter" }),
        card("Top pages", bars(pageRows, { head: ["Page", state.pagesTab === "top" ? "Visitors" : "Visits"] }), {
          end: tabs([["top", "Pages"], ["entry", "Entry"], ["exit", "Exit"]], state.pagesTab, (id) => { state.pagesTab = id; draw(); }),
        }),
        card("Locations", bars(d.countries, { head: ["Country", "Visitors"], label: (r) => countryName(r.label), lead: (r) => h("span", { class: "flag", text: flag(r.label) }) }))),
      h("div", { class: "grid g3" },
        card("Devices", bars(d.devices.device, { head: ["Device", "Visitors"] })),
        card("Browsers", bars(d.devices.browser, { head: ["Browser", "Visitors"] })),
        card("Operating systems", bars(d.devices.os, { head: ["System", "Visitors"] }))),
      conversions(d, pickSource),
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
    pageHead([icon("chart", 20), h("h1", { text: "Analytics" }), h("span", { class: "muted", text: site?.domains[0] }), refreshed], [filter, rangeButton, liveButton]),
    body);
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
        class: `pick${r.label === state.source ? " on" : ""}`, tabindex: "0", onclick: () => pickSource(r.label),
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
  const draw = () => {
    const fresh = appSection(d);
    node.replaceWith(fresh);
  };
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
  const updated = h("span", { class: "muted", text: "Connecting…" });
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
      const d = await api(`/api/sites/${key}/live`);
      latest = d;
      draw();
      updated.textContent = `Updated ${clock(new Date(d.at))}`;
    } catch (err) {
      if (!(err instanceof SignedOut)) updated.textContent = "Couldn't update. Trying again…";
    }
  }

  function draw() {
    const d = latest;
    const s = state.sites.find((x) => x.key === key);
    if (s) s.live = d.visitors;
    kpis.replaceChildren(
      h("div", { class: "card kpi hero" }, h("span", { class: "label", text: "Visitors right now" }), h("span", { class: "value num" }, h("i", { class: `dot${d.visitors ? " pulse" : " idle"}`, style: { width: "12px", height: "12px" } }), int(d.visitors)),
        h("span", { class: "delta", text: "In the last 5 minutes" })),
      ...[["Visits today", d.today.visits], ["Visitors today", d.today.visitors], ["Page views today", d.today.pageviews]].map(([label, v]) =>
        h("div", { class: "card kpi" }, h("span", { class: "label", text: label }), h("span", { class: "value num", text: int(v) }), h("span", { class: "delta", text: "Since midnight" }))));
    globe.update(d.countries);
    overCount.textContent = d.visitors ? `${d.visitors} in ${d.countries.length} ${d.countries.length === 1 ? "country" : "countries"}` : "";
    canvas.setAttribute("aria-label", d.visitors ? `Visitors right now: ${d.countries.map((c) => `${c.v} in ${countryName(c.label)}`).join(", ")}` : "No visitors right now");
    caption.textContent = d.visitors ? "Each dot is a country with visitors right now. Drag to turn the globe." : "No one's on the site right now. This updates every 5 seconds.";
    locations.replaceChildren(bars(d.countries, {
      head: ["Country", "Visitors"], label: (r) => countryName(r.label), lead: (r) => h("span", { class: "flag", text: flag(r.label) }),
      onPick: (r) => globe.focus(r.label), canPick: (r) => r.label !== "Unknown",
    }));
    pages.replaceChildren(bars(d.pages, { head: ["Page", "Visitors"] }));
    sources.replaceChildren(bars(d.sources, { head: ["Source", "Visitors"] }));
    minuteBars(perMinute, d.perMinute, (v) => `${v} ${v === 1 ? "page view" : "page views"}`);
    feed.replaceChildren(...(d.recent.length ? d.recent.map((e) => h("div", { class: "feed-row" },
      h("span", { class: "muted" }, icon(e.app ? "app" : EVENT_ICONS[e.name] ?? "spark", 18)),
      h("div", { class: "what" }, h("span", { text: describe(e) }),
        h("small", { text: [e.country ? `${flag(e.country)} ${countryName(e.country)}` : null, e.source, e.app ? e.os : e.browser].filter(Boolean).join(" · ") })),
      h("time", { datetime: e.ts, text: ago(e.ts) }))) : [h("p", { class: "empty-note", text: "Nothing in the last 30 minutes." })]));
  }

  every(5000, load);
  queueMicrotask(load);

  return h("div", { class: "page" },
    pageHead([icon("live", 20), h("h1", { text: "Live view" }), h("span", { class: "badge ok" }, h("i", { class: "dot pulse" }), "Live"), h("span", { class: "muted", text: site?.domains[0] }), updated],
      h("a", { class: "btn", href: `/sites/${key}` }, icon("chart", 16), "Analytics")),
    kpis,
    h("div", { class: "grid g-globe" }, globeCard,
      h("div", { class: "stack" }, card("Top locations", locations, { sub: "Click to find one on the globe" }), card("Pages being viewed", pages))),
    h("div", { class: "grid g3" },
      card("Page views per minute", perMinute, { sub: "Last 30 minutes" }),
      card("Sources right now", sources),
      card("Recent activity", feed, { sub: "Last 30 minutes" })));
}

// ---------- Settings ----------
async function settingsPage(key) {
  const { site, snippet } = await api(`/api/sites/${key}`);
  const saveSite = async (body, button, message) => {
    button.disabled = true;
    try {
      const { site: fresh } = await api(`/api/sites/${key}`, { method: "PATCH", body });
      Object.assign(site, fresh);
      state.sites = null;
      toast(message);
      render();
    } catch (err) {
      if (!(err instanceof SignedOut)) toast(err.message);
      button.disabled = false;
    }
  };

  const name = h("input", { class: "input", id: "s-name", value: site.name });
  let zones;
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [site.timezone];
  }
  if (!zones.includes(site.timezone)) zones = [site.timezone, ...zones];
  const zone = h("select", { class: "input", id: "s-zone" }, zones.map((z) => h("option", { value: z, text: z.replaceAll("_", " "), selected: z === site.timezone })));
  const saveGeneral = h("button", { class: "btn primary", type: "submit", text: "Save" });

  let domains = [...site.domains];
  const domainList = h("div", { style: { display: "grid", gap: "6px" } });
  const newDomain = h("input", { class: "input", placeholder: "shop.example.com", "aria-label": "Another domain" });
  const saveDomains = h("button", { class: "btn primary", type: "button", text: "Save domains", onclick: () => saveSite({ domains }, saveDomains, "Domains saved") });
  const drawDomains = () => domainList.replaceChildren(...domains.map((d, i) => h("div", { class: "bar-row", style: { background: "var(--surface-2)" } },
    h("span", { class: "l", text: d }), domains.length > 1 ? h("button", { class: "btn plain", type: "button", text: "Remove", onclick: () => { domains.splice(i, 1); drawDomains(); } }) : h("span", { class: "faint", text: "Main" }))));
  drawDomains();

  const confirmInput = h("input", { class: "input", placeholder: site.domains[0], "aria-label": `Type ${site.domains[0]} to confirm` });
  const deleteButton = h("button", {
    class: "btn critical", type: "button", text: "Delete this site",
    onclick: async () => {
      deleteButton.disabled = true;
      try {
        await api(`/api/sites/${key}`, { method: "DELETE", body: { confirm: confirmInput.value } });
        state.sites = null;
        toast(`${site.domains[0]} deleted`);
        go("/");
      } catch (err) {
        if (!(err instanceof SignedOut)) toast(err.message);
        deleteButton.disabled = false;
      }
    },
  });
  const copyButton = h("button", { class: "btn copy", type: "button", onclick: () => copy(snippet, copyButton) }, icon("copy", 14), "Copy");

  return h("div", { class: "page narrow" },
    pageHead([icon("settings", 20), h("h1", { text: "Settings" }), h("span", { class: "muted", text: site.domains[0] })]),
    h("div", { class: "stack" },
      card("Site", h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); saveSite({ name: name.value, timezone: zone.value }, saveGeneral, "Saved"); } },
        h("div", { class: "field" }, h("label", { for: "s-name", text: "Name" }), name),
        h("div", { class: "field" }, h("label", { for: "s-zone", text: "Time zone" }), zone, h("span", { class: "help", text: "Days in your reports start at midnight here." })),
        h("div", {}, saveGeneral))),
      card("Domains", h("div", { class: "form" },
        h("p", { class: "muted", text: "Pages on these addresses and their subdomains are counted. Visits from anywhere else are turned away, so no one can send made-up visits from their own site." }),
        domainList,
        h("form", { class: "input-row", onsubmit: (e) => { e.preventDefault(); const d = newDomain.value.trim(); if (d && !domains.includes(d)) { domains.push(d); newDomain.value = ""; drawDomains(); } } },
          newDomain, h("button", { class: "btn", type: "submit", text: "Add" })),
        h("div", {}, saveDomains))),
      card("Tracking code", h("div", { style: { display: "grid", gap: "10px" } }, h("div", { class: "code-block" }, snippet, copyButton),
        h("a", { href: `/sites/${key}/setup`, text: "Steps for WordPress, Shopify, Wix and more" }))),
      h("div", { class: "card", style: { borderColor: "#fbd5d0" } }, h("div", { class: "card-head" }, h("h2", { text: "Delete site" })),
        h("div", { class: "card-body form" },
          h("p", { class: "muted", text: "This deletes the site and every visit and event it collected. It can't be undone." }),
          h("div", { class: "field" }, h("label", { text: `Type ${site.domains[0]} to confirm` }), confirmInput),
          h("div", {}, deleteButton)))));
}

// ---------- Rendering ----------
const ROUTES = [
  [/^\/$/, () => ["home", null, homePage()]],
  [/^\/sites\/new$/, () => ["add", null, addSitePage()]],
  [/^\/sites\/(p_[a-z0-9]+)$/, (k) => ["analytics", k, analyticsPage(k)]],
  [/^\/sites\/(p_[a-z0-9]+)\/live$/, (k) => ["live", k, livePage(k)]],
  [/^\/sites\/(p_[a-z0-9]+)\/setup$/, (k) => ["setup", k, setupPage(k)]],
  [/^\/sites\/(p_[a-z0-9]+)\/settings$/, (k) => ["settings", k, settingsPage(k)]],
];

let rendering = 0;
async function render() {
  const run = ++rendering;
  for (const fn of leaving.splice(0)) fn();
  closePopover();
  const root = $("app");
  const path = location.pathname;
  const auth = path === "/login" || path === "/signup";
  try {
    if (state.user === undefined) {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      state.user = res.ok ? (await res.json()).user : null;
    }
    if (run !== rendering) return;
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
    document.title = `${{ home: "Websites", add: "Add a website", analytics: "Analytics", live: "Live view", setup: "Setup", settings: "Settings" }[active]}${site ? ` · ${site.name}` : ""} · Statiku`;
    window.scrollTo(0, 0);
  } catch (err) {
    if (err instanceof SignedOut || run !== rendering) return;
    const main = $("main") ?? root;
    main.replaceChildren(h("div", { class: "page" }, failure(err)));
  }
}

render();
