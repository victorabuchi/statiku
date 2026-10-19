// The Waymark website script. It stores nothing in the browser and sends no identifier: each event carries the page
// (its query string dropped, apart from campaign tags), the referrer, the window width and any props.
//
//   <script defer data-project="p_…" src="https://<waymark host>/s.js"></script>
//     data-api="https://…/e"  send events elsewhere, such as through your own domain
//     data-hash               count #/routes as pages
//     data-local              count on localhost too
//
//   waymark("signup", { props: { plan: "pro" }, revenue: { amount: 9, currency: "EUR" } })
//   <a data-track="download" data-track-os="mac" href="…">  sends "download" with { os: "mac" } on click
//
// Clicks on files (.dmg, .zip, .exe…) send "download". Clicks on Polar and Stripe checkout links send "checkout" with
// a reference added to the link, which the payment webhook brings back so the purchase is credited to its source.
(function () {
  var w = window, d = document, loc = location, nav = navigator, script = d.currentScript, last;
  if (!script) return;
  var attr = function (name) { return script.getAttribute("data-" + name); };
  var key = attr("project"), api = attr("api") || new URL("e", script.src).href, hashRoutes = attr("hash") != null;
  var CHECKOUT = /^https:\/\/(buy\.polar\.sh|buy\.stripe\.com)\//;
  var FILE = /\.(dmg|pkg|zip|exe|msi|appimage|deb|rpm|apk)$/i;

  function send(name, opts) {
    opts = opts || {};
    if ((/^(localhost|127\.|\[::1\])/.test(loc.hostname) && attr("local") == null) || loc.protocol == "file:") return;
    if (nav.webdriver || w.Cypress) return;
    try { if (localStorage.waymark_ignore) return; } catch (e) {}
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
    // A plain-text body keeps it a simple request with no preflight; both ways finish after the page closes.
    (nav.sendBeacon && nav.sendBeacon(api, body)) || fetch(api, { method: "POST", body: body, keepalive: true }).catch(function () {});
  }

  function page() {
    var p = loc.pathname + (hashRoutes ? loc.hash : "");
    if (p != last) { last = p; send("pageview"); }
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
      props.ref = url.searchParams.get(param) || "wm_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
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

  // Calls made before the script loaded: window.waymark = window.waymark || function () { (waymark.q = waymark.q || []).push(arguments) }
  var queued = (w.waymark && w.waymark.q) || [];
  w.waymark = send;
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
})();
