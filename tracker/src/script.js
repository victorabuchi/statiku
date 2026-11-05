// The Statiku website script. It stores nothing in the browser and sends no identifier: each event carries the page
// (its query string dropped, apart from campaign tags), the referrer, the window width and any props.
//
//   <script defer data-project="p_…" src="https://<statiku host>/s.js"></script>
//     data-api="https://…/e"  send events elsewhere, such as through your own domain
//     data-hash               count #/routes as pages
//     data-local              count on localhost too
//     data-lite               page views and events only: no heatmap clicks, scroll depth, page speed or errors
//
//   statiku("signup", { props: { plan: "pro" }, revenue: { amount: 9, currency: "EUR" } })
//   <a data-track="download" data-track-os="mac" href="…">  sends "download" with { os: "mac" } on click
//
// Clicks on files (.dmg, .zip, .exe…) send "download". Clicks on Polar and Stripe checkout links send "checkout" with
// a reference added to the link, which the payment webhook brings back so the purchase is credited to its source.
// While the page is in view it checks in every 30 seconds, and it says when the page closes, so the live view shows who
// is there right now and a visit's length is the time spent on it; neither is stored as an event.
// For heatmaps it notes where clicks land on the page (and the text of the link or button, unless it looks like an
// address or a number) and how far down the page a visit read; for injuries, the page's speed (Core Web Vitals), the
// status it came with, and its first few script errors. None of it is stored as an event.
// A site can also ask its visitors to share their exact location for its live view: only if its owner turned that on,
// and only with the visitor's say-so, twice over (a card, then the browser's own prompt).
(function () {
  var w = window, d = document, loc = location, nav = navigator, script = d.currentScript, last, beats = 0, deepest = 0, clicks = 0, errors = 0, measured;
  if (!script) return;
  var attr = function (name) { return script.getAttribute("data-" + name); };
  var key = attr("project"), api = attr("api") || new URL("e", script.src).href, hashRoutes = attr("hash") != null, lite = attr("lite") != null;
  var CHECKOUT = /^https:\/\/buy\.(polar\.sh|stripe\.com)\//;
  var FILE = /\.(dmg|pkg|zip|exe|msi|appimage|deb|rpm|apk)$/i;

  // Not counted: local pages (unless data-local), automated browsers, the page shown behind a heatmap in Statiku, and
  // the owner's own browser once they opt out.
  function skip() {
    if ((/^(localhost|127\.|\[::1\])/.test(loc.hostname) && attr("local") == null) || loc.protocol == "file:" || nav.webdriver) return true;
    if (loc.hash.indexOf("statiku-heatmap") >= 0) return true;
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
    if (p != last) {
      // A single-page app's previous page: how far down it was read.
      if (last && deepest && !lite) send("_d", { props: { d: deepest, path: last } });
      last = p; beats = 0; deepest = 0; clicks = 0; scrolled();
      send("pageview");
    }
  }

  // How far down the page has been seen, in percent.
  function scrolled() {
    var de = d.documentElement, seen = Math.round(((w.scrollY || 0) + w.innerHeight) / Math.max(de.scrollHeight, 1) * 100);
    if (seen > deepest) deepest = Math.min(seen, 100);
  }

  // Where a click landed, for heatmaps: across as a share of the page's width (pages reflow), down in pixels.
  function spot(e) {
    var de = d.documentElement, t = e.target.closest && e.target.closest("a,button,[role=button],summary,label,input[type=submit]");
    var text = t ? (t.getAttribute("aria-label") || t.value || t.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
    if (/@|\d{5}/.test(text)) text = "";
    send("_c", { props: { x: Math.round(e.pageX / Math.max(de.scrollWidth, 1) * 1000) / 1000, y: Math.round(e.pageY), h: de.scrollHeight, t: text } });
  }

  function click(e) {
    if (e.type == "auxclick" && e.button != 1) return;
    // A real click (not Enter on a link), a few dozen a page at most.
    if (e.type == "click" && e.detail > 0 && !lite && clicks++ < 40) spot(e);
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
  w.addEventListener("scroll", scrolled, { passive: true });
  // Closing the page: how far it was read and, the first time, how fast it was (the vitals are final by then).
  w.addEventListener("pagehide", function () {
    var props = lite ? null : { d: deepest };
    if (props && !measured) { measured = 1; for (var k in vitals) props[k] = vitals[k]; }
    send("_l", { props: props });
  });

  // Page speed as visitors get it: the largest paint (lcp), the slowest response to a tap or key (inp), how much the
  // page shifted as it loaded (cls), the first byte (ttfb), all in milliseconds but cls, and the page's HTTP status.
  var vitals = {};
  function watch(type, fn, extra) {
    try { new PerformanceObserver(function (l) { l.getEntries().forEach(fn); }).observe(Object.assign({ type: type, buffered: true }, extra)); } catch (e) {}
  }
  if (!lite && w.PerformanceObserver) {
    var nav0 = performance.getEntriesByType && performance.getEntriesByType("navigation")[0], shift = 0, windowStart = 0, windowLast = 0;
    if (nav0) {
      vitals.ttfb = Math.round(Math.max(0, nav0.responseStart - (nav0.activationStart || 0)));
      if (nav0.responseStatus) vitals.st = nav0.responseStatus;
    }
    watch("largest-contentful-paint", function (e) { vitals.lcp = Math.round(e.startTime); });
    watch("event", function (e) { if (e.interactionId && e.duration > (vitals.inp || 0)) vitals.inp = Math.round(e.duration); }, { durationThreshold: 16 });
    // Layout shifts in bursts (at most a second apart, five seconds long); the worst burst counts.
    watch("layout-shift", function (e) {
      if (e.hadRecentInput) return;
      if (e.startTime - windowLast > 1000 || e.startTime - windowStart > 5000) { windowStart = e.startTime; shift = 0; }
      windowLast = e.startTime;
      shift += e.value;
      if (shift > (vitals.cls || 0)) vitals.cls = Math.round(shift * 1000) / 1000;
    });
  }
  // The page's own script errors, the first five, for injuries.
  function failed(message, source, line) {
    if (lite || errors++ > 4 || !message) return;
    send("_e", { props: { m: String(message).slice(0, 300), s: String(source || "").split("?")[0].slice(0, 300), l: line || 0 } });
  }
  w.addEventListener("error", function (e) { if (e.message) failed(e.message, e.filename, e.lineno); });
  w.addEventListener("unhandledrejection", function (e) { var r = e.reason; failed(r && r.message ? r.message : r, r && r.stack ? (r.stack.match(/https?:\/\/[^\s)]+/) || [""])[0].replace(/:\d+:\d+$/, "") : ""); });

  // Exact location, on sites that ask for it. Someone who already allowed it shares it without being asked again;
  // someone the browser has been told to refuse is never asked; anyone else sees a card a few seconds in, and only
  // "Share" brings up the browser's prompt. "Not now" lasts the visit, kept by Statiku's server, not in the browser.
  // The first fix at once, then sharper ones as GPS or Wi-Fi settles, each sent only when it's at least twice as sure,
  // for half a minute at most or until it's sure to within 20 metres.
  function locate() {
    var best = 1 / 0, id, timer, stop = function () { nav.geolocation.clearWatch(id); clearTimeout(timer); };
    id = nav.geolocation.watchPosition(function (p) {
      var c = p.coords;
      if (c.accuracy * 2 <= best) { best = c.accuracy; send("_loc", { props: { lat: c.latitude, lon: c.longitude, acc: Math.round(c.accuracy) } }); }
      if (best <= 20) stop();
    }, function () { if (best == 1 / 0) send("_noloc"); stop(); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 2e4 });
    timer = setTimeout(stop, 3e4);
  }

  var CARD = ".box{position:fixed;left:16px;bottom:16px;z-index:2147483647;max-width:320px;padding:16px;border-radius:14px;" +
    "background:#fff;color:#1d1d1f;box-shadow:0 10px 40px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.06);" +
    "font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:left;animation:in .25s ease}" +
    "p{margin:0 0 14px;font-size:15px;font-weight:500}" +
    ".row{display:flex;gap:8px;justify-content:flex-end}" +
    "button{font:inherit;font-weight:600;border:0;border-radius:9px;padding:7px 14px;cursor:pointer;background:#ececf0;color:inherit}" +
    ".yes{background:#0071e3;color:#fff}@keyframes in{from{opacity:0;transform:translateY(8px)}}" +
    "@media (prefers-color-scheme:dark){.box{background:#1d1d1f;color:#f5f5f7;box-shadow:0 10px 40px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08)}button{background:#2c2c2e}}" +
    "@media (max-width:480px){.box{left:12px;right:12px;bottom:12px;max-width:none}}@media (prefers-reduced-motion:reduce){.box{animation:none}}";

  function ask(site) {
    var host = d.createElement("div"), root = host.attachShadow({ mode: "closed" });
    var el = function (tag, text, cls) { var n = d.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
    var box = el("div", "", "box"), row = el("div", "", "row"), no = el("button", "Not now"), yes = el("button", "Share", "yes");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", site + " would like to access your location");
    no.onclick = function () { host.remove(); send("_noloc"); };
    yes.onclick = function () { host.remove(); locate(); };
    row.append(no, yes);
    box.append(el("p", site + " would like to access your location"), row);
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
