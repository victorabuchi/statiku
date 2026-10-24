// The landing page's "video": real screenshots of Statiku (scripts/shots.ts) played scene by scene with a cursor,
// inside a browser window (a phone on narrow screens), with a tab for each scene. Each scene is a function of its own
// clock, so pausing, jumping to a tab and reduced motion cost nothing. It plays only while on screen, and never for
// someone who asked for less motion: they see each scene's last picture.
(() => {
  const root = document.getElementById("film");
  if (!root) return;
  const TICK = 100;
  const scenes = window.STATIKU_SCENES;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (sel) => root.querySelector(sel);
  let data = null, set = "desktop", clock = { scene: 0, t: 0 }, playing = true, visible = false, scale = 1, last = { scene: -1, t: 0 };

  root.innerHTML = `
    <div class="film-stage">
      <div class="film-glow" aria-hidden="true"></div>
      <div class="film-window">
        <div class="film-chrome" aria-hidden="true"><span class="film-dots"><i></i><i></i><i></i></span><span class="film-url"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4"/></svg><span data-url></span></span></div>
        <div class="film-viewport" data-viewport aria-hidden="true">
          <div class="film-frames" data-frames></div>
          <div class="film-ping" data-ping></div>
          <div class="film-cursor" data-cursor><i class="film-ripple" data-ripple></i><svg width="22" height="26" viewBox="0 0 18 22"><path d="M1 1L1 17L5 13L8 20L10.5 19L7.5 12L13 12Z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg></div>
        </div>
        <button type="button" class="film-play" data-play aria-label="Pause"></button>
      </div>
      <div class="film-tabs" role="tablist" aria-label="Scenes" data-tabs></div>
    </div>
    <p class="film-caption" data-caption aria-live="polite"></p>`;
  const el = { frames: $("[data-frames]"), cursor: $("[data-cursor]"), ripple: $("[data-ripple]"), tabs: $("[data-tabs]"), caption: $("[data-caption]"), url: $("[data-url]"), play: $("[data-play]"), viewport: $("[data-viewport]"), glow: $(".film-glow"), ping: $("[data-ping]") };
  el.tabs.innerHTML = scenes.map((s, i) => `<button type="button" role="tab" class="film-tab" data-i="${i}">${s.tab}<i class="film-progress"></i></button>`).join("");
  const tabEls = [...el.tabs.children];

  const frameAt = (def, t) => {
    let f = def.frames[0];
    for (const x of def.frames) if (x[0] <= t) f = x;
    return f[1];
  };
  const beatAt = (def, t) => {
    let b = [0, null];
    for (const x of def.beats) if (x[0] <= t) b = x;
    return { target: b[1], press: Boolean(b[2] && t < b[0] + b[2]), key: b[0] };
  };
  const narrow = () => innerWidth < 640 || root.clientWidth < 520;

  function build() {
    set = narrow() && data.phone ? "phone" : "desktop";
    root.classList.toggle("is-phone", set === "phone");
    const d = data[set];
    el.frames.innerHTML = Object.entries(d.frames).map(([name, file]) => `<img src="/site/film/${file}?v=${root.dataset.v ?? ""}" alt="" data-name="${name}" decoding="async" draggable="false">`).join("");
    el.viewport.style.aspectRatio = `${d.size[0]} / ${d.size[1]}`;
    resize();
    render(true);
  }
  function resize() {
    if (data) scale = el.viewport.clientWidth / data[set].size[0];
  }

  let shown = "";
  function render(force) {
    if (!data) return;
    const def = scenes[clock.scene], t = reduced ? def.dur - 1 : clock.t, d = data[set];
    const name = frameAt(def, t);
    if (force || name !== shown) {
      shown = name;
      for (const img of el.frames.children) img.classList.toggle("on", img.dataset.name === name);
    }
    el.url.textContent = def.url;
    el.glow.style.background = `radial-gradient(closest-side, ${def.glow}, transparent)`;
    tabEls.forEach((b, i) => {
      b.setAttribute("aria-selected", String(i === clock.scene));
      b.querySelector(".film-progress").style.width = i === clock.scene ? `${(t / def.dur) * 100}%` : "0";
    });
    if (el.caption.dataset.id !== def.id) {
      el.caption.dataset.id = def.id;
      el.caption.innerHTML = `<b>${def.title}</b> ${def.caption}`;
      el.caption.classList.remove("in");
      void el.caption.offsetWidth;
      el.caption.classList.add("in");
    }
    const beat = beatAt(def, t), r = beat.target && d.rects[beat.target];
    if (!r) el.cursor.style.opacity = "0";
    else {
      el.cursor.style.transform = `translate(${(r.x + Math.min(r.w / 2, 70)) * scale}px, ${(r.y + r.h / 2) * scale}px)`;
      el.cursor.style.opacity = "1";
    }
    if (beat.press && el.ripple.dataset.k !== `${clock.scene}-${beat.key}`) {
      el.ripple.dataset.k = `${clock.scene}-${beat.key}`;
      el.ripple.classList.remove("go");
      void el.ripple.offsetWidth;
      el.ripple.classList.add("go");
    }
    // A visitor arriving: a green ring where the scene says, as on the live globe.
    const ping = (def.pings ?? []).find(([at]) => last.scene === clock.scene && last.t < at && clock.t >= at);
    if (ping && !reduced && d.rects[ping[1]]) {
      const p = d.rects[ping[1]];
      el.ping.style.transform = `translate(${(p.x + p.w / 2) * scale}px, ${(p.y + p.h / 2) * scale}px)`;
      el.ping.classList.remove("go");
      void el.ping.offsetWidth;
      el.ping.classList.add("go");
    }
    el.play.setAttribute("aria-label", running() ? "Pause" : "Play");
    el.play.innerHTML = running()
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l14 8-14 8V4z"/></svg>';
    last = { scene: clock.scene, t: clock.t };
  }

  const running = () => playing && visible && !reduced;
  setInterval(() => {
    if (!running()) return;
    const def = scenes[clock.scene];
    clock = clock.t + TICK >= def.dur ? { scene: (clock.scene + 1) % scenes.length, t: 0 } : { scene: clock.scene, t: clock.t + TICK };
    render();
    const tab = tabEls[clock.scene], bar = el.tabs;
    if (clock.t === 0 && tab) bar.scrollTo({ left: tab.offsetLeft - (bar.clientWidth - tab.offsetWidth) / 2, behavior: "smooth" });
  }, TICK);

  el.tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".film-tab");
    if (!b) return;
    clock = { scene: +b.dataset.i, t: 0 };
    last = { scene: clock.scene, t: 0 };
    playing = true;
    render();
  });
  el.play.addEventListener("click", () => {
    playing = !playing;
    render();
  });
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    render();
  }, { threshold: 0.2 }).observe(root);
  let wasNarrow = null;
  new ResizeObserver(() => {
    if (!data) return;
    if (wasNarrow !== null && narrow() !== wasNarrow) build();
    else {
      resize();
      render();
    }
    wasNarrow = narrow();
  }).observe(root);
  fetch(`/site/film/film.json?v=${root.dataset.v ?? ""}`).then((r) => r.json()).then((json) => {
    data = json;
    wasNarrow = narrow();
    build();
  });
})();
