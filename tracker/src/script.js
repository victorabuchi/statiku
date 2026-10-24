// The Statiku website script. It stores nothing in the browser and sends no identifier: each event carries the page
// (its query string dropped, apart from campaign tags), the referrer, the window width and any props.
//
//   <script defer data-project="p_…" src="https://<statiku host>/s.js"></script>
//     data-api="https://…/e"  send events elsewhere, such as through your own domain
//     data-hash               count #/routes as pages
//     data-local              count on localhost too
//
//   statiku("signup", { props: { plan: "pro" }, revenue: { amount: 9, currency: "EUR" } })
//   <a data-track="download" data-track-os="mac" href="…">  sends "download" with { os: "mac" } on click
//
// Clicks on files (.dmg, .zip, .exe…) send "download". Clicks on Polar and Stripe checkout links send "checkout" with
// a reference added to the link, which the payment webhook brings back so the purchase is credited to its source.
// While the page is in view it checks in every 30 seconds, and it says when the page closes, so the live view shows who
// is there right now and a visit's length is the time spent on it; neither is stored as an event.
// A site can also ask its visitors to share their exact location for its live view: only if its owner turned that on,
// and only with the visitor's say-so, twice over (a card, then the browser's own prompt).
(function () {
  var w = window, d = document, loc = location, nav = navigator, script = d.currentScript, last, beats = 0;
  if (!script) return;
  var attr = function (name) { return script.getAttribute("data-" + name); };
  var key = attr("project"), api = attr("api") || new URL("e", script.src).href, hashRoutes = attr("hash") != null;
  var CHECKOUT = /^https:\/\/buy\.(polar\.sh|stripe\.com)\//;
  var FILE = /\.(dmg|pkg|zip|exe|msi|appimage|deb|rpm|apk)$/i;

  // Not counted: local pages (unless data-local), automated browsers, and the owner's own browser once they opt out.
  function skip() {
    if ((/^(localhost|127\.|\[::1\])/.test(loc.hostname) && attr("local") == null) || loc.protocol == "file:" || nav.webdriver) return true;
    try { return !!localStorage.statiku_ignore; } catch (e) { return false; }
  }

  function send(name, opts) {
    opts = opts || {};
    if (skip()) return;
    var tags = loc.search.slice(1).split("&").filter(function (p) { return /^(utm_[a-z]+|ref|source|via)=/.test(p); }).join("&");
    var body = JSON.stringify({
      k: key,
      n: name,
      u: loc.protocol + "//" + loc.host + loc.pathname + (tags ? "?" + tags : "") + (hashRoutes ? loc.hash : ""),
      r: d.referrer || null,
      w: w.innerWidth,
      p: opts.props,
      $: opts.revenue
    });
    // A beacon is a plain-text POST with no preflight, and it is delivered even as the page closes.
    nav.sendBeacon(api, body);
  }

  function page() {
    var p = loc.pathname + (hashRoutes ? loc.hash : "");
    if (p != last) { last = p; beats = 0; send("pageview"); }
  }

  function click(e) {
    if (e.type == "auxclick" && e.button != 1) return;
    var t = e.target, el = t.closest("[data-track]"), a = t.closest("a[href]");
    var props = {}, name, i, at, url, param;
    if (el) {
      name = el.getAttribute("data-track");
      for (i = 0; (at = el.attributes[i]); i++) if (!at.name.indexOf("data-track-")) props[at.name.slice(11)] = at.value;
    }
    if (a && CHECKOUT.test(a.href)) {
      url = new URL(a.href);
      param = /stripe/.test(url.host) ? "client_reference_id" : "reference_id";
      props.ref = url.searchParams.get(param) || "stk_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
      url.searchParams.set(param, props.ref);
      // Rewritten before the page's own handlers run, so a checkout opened in an overlay gets it too.
      a.href = url.href;
      name = name || "checkout";
    } else if (a && FILE.test(a.pathname)) {
      props.file = a.pathname.split("/").pop();
      name = name || "download";
    }
    if (name) send(name, { props: props });
  }

  // Calls made before the script loaded: window.statiku = window.statiku || function () { (statiku.q = statiku.q || []).push(arguments) }
  var queued = (w.statiku && w.statiku.q) || [];
  w.statiku = send;
  for (var i = 0; i < queued.length; i++) send(queued[i][0], queued[i][1]);

  d.addEventListener("click", click, true);
  d.addEventListener("auxclick", click, true);
  var push = history.pushState;
  if (push) {
    history.pushState = function () { push.apply(this, arguments); page(); };
    w.addEventListener("popstate", page);
  }
  if (hashRoutes) w.addEventListener("hashchange", page);
  // A page restored from the back-forward cache is a new view; a prerendered one counts only once it is shown.
  w.addEventListener("pageshow", function (e) { if (e.persisted) { last = null; page(); } });
  if (d.prerendering) d.addEventListener("prerenderingchange", page, { once: true });
  else page();
  // In view: a check-in every 30 seconds, for up to half an hour on one page. Closing the page: gone at once.
  setInterval(function () { d.hidden || beats++ > 59 || send("_p"); }, 3e4);
  w.addEventListener("pagehide", function () { send("_l"); });

  // Exact location, on sites that ask for it. Someone who already allowed it shares it without being asked again;
  // someone the browser has been told to refuse is never asked; anyone else sees a card a few seconds in, and only
  // "Share" brings up the browser's prompt. "Not now" lasts the visit, kept by Statiku's server, not in the browser.
  function locate() {
    nav.geolocation.getCurrentPosition(function (p) {
      send("_loc", { props: { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) } });
    }, function () { send("_noloc"); }, { maximumAge: 6e5, timeout: 2e4 });
  }

  var CARD = ".box{position:fixed;left:16px;bottom:16px;z-index:2147483647;max-width:320px;padding:16px;border-radius:14px;" +
    "background:#fff;color:#1d1d1f;box-shadow:0 10px 40px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.06);" +
    "font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:left;animation:in .25s ease}" +
    "b{display:block;font-size:15px;margin-bottom:4px}p{margin:0 0 12px;color:#56565c}" +
    ".row{display:flex;gap:8px;justify-content:flex-end}" +
    "button{font:inherit;font-weight:600;border:0;border-radius:9px;padding:7px 14px;cursor:pointer;background:#ececf0;color:inherit}" +
    ".yes{background:#0071e3;color:#fff}@keyframes in{from{opacity:0;transform:translateY(8px)}}" +
    "@media (prefers-color-scheme:dark){.box{background:#1d1d1f;color:#f5f5f7;box-shadow:0 10px 40px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08)}p{color:#a1a1a6}button{background:#2c2c2e}}" +
    "@media (max-width:480px){.box{left:12px;right:12px;bottom:12px;max-width:none}}@media (prefers-reduced-motion:reduce){.box{animation:none}}";

  function ask(site) {
    var host = d.createElement("div"), root = host.attachShadow({ mode: "closed" });
    var el = function (tag, text, cls) { var n = d.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
    var box = el("div", "", "box"), row = el("div", "", "row"), no = el("button", "Not now"), yes = el("button", "Share", "yes");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Share your location?");
    no.onclick = function () { host.remove(); send("_noloc"); };
    yes.onclick = function () { host.remove(); locate(); };
    row.append(no, yes);
    box.append(el("b", "Share your location?"), el("p", site + " would like to show where its visitors are on a live map. Your location is seen only while you're on the site, and is never stored."), row);
    root.append(el("style", CARD), box);
    d.body.append(host);
  }

  if (!skip() && nav.geolocation && w.fetch) {
    fetch(new URL("v1/site?k=" + encodeURIComponent(key), script.src)).then(function (r) { return r.json(); }).then(function (c) {
      if (!c.ask) return;
      (nav.permissions ? nav.permissions.query({ name: "geolocation" }) : Promise.resolve({ state: "prompt" })).then(function (p) {
        if (p.state == "granted") locate();
        else if (p.state == "prompt" && c.prompt) setTimeout(function () { ask(c.site); }, 3e3);
      }, function () {});
    }).catch(function () {});
  }
})();
