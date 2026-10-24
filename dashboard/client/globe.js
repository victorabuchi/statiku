// The live view's globe: the world on a canvas, turning slowly, with a glowing dot on each country that has visitors
// right now, sized by how many. Drag to turn it, hover a dot for its numbers. Statiku only knows a visitor's country,
// so each dot sits at a point on that country's largest landmass. Map data: world-atlas (Natural Earth).
import { geoDistance, geoGraticule10, geoOrthographic, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import world from "world-atlas/countries-110m.json";
import places from "./countries.json";

const LIVE = "#29c46b";

export function createGlobe(canvas, { onHover } = {}) {
  const ctx = canvas.getContext("2d");
  const countries = feature(world, world.objects.countries).features;
  const borders = mesh(world, world.objects.countries, (a, b) => a !== b);
  const graticule = geoGraticule10();
  const projection = geoOrthographic().clipAngle(90).precision(0.6);
  const path = geoPath(projection, ctx);
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let rotation = [-15, -32, 0];
  let dots = [];
  let lit = new Set();
  let size = { w: 0, h: 0 };
  let dragging = null, hovered = null, focusing = null, idleUntil = 0, frame = 0, alive = true;

  const radius = (d) => 3.5 + Math.sqrt(d.v) * 2.4;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = { w: canvas.clientWidth, h: canvas.clientHeight };
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Room above for the title and below for the caption.
    projection.translate([size.w / 2, (size.h - 20) / 2 + 6]).scale(Math.max(60, Math.min(size.w * 0.42, (size.h - 100) / 2)));
  }

  function draw(t) {
    projection.rotate(rotation);
    const { w, h } = size;
    const [cx, cy] = projection.translate(), r = projection.scale();
    ctx.clearRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(cx, cy, r * 0.92, cx, cy, r * 1.2);
    glow.addColorStop(0, "rgba(41, 196, 107, 0.12)");
    glow.addColorStop(1, "rgba(41, 196, 107, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.2, 0, 2 * Math.PI);
    ctx.fill();

    const ocean = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    ocean.addColorStop(0, "#22303a");
    ocean.addColorStop(1, "#161c22");
    ctx.beginPath();
    path({ type: "Sphere" });
    ctx.fillStyle = ocean;
    ctx.fill();
    ctx.beginPath();
    path(graticule);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 0.6;
    ctx.stroke();

    for (const c of countries) {
      ctx.beginPath();
      path(c);
      ctx.fillStyle = lit.has(places.ids[c.id ?? c.properties.name]) ? "#2f6b4b" : "#3b4651";
      ctx.fill();
    }
    ctx.beginPath();
    path(borders);
    ctx.strokeStyle = "rgba(17, 19, 21, 0.75)";
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.beginPath();
    path({ type: "Sphere" });
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Dots on the side facing us, a ring pulsing out of each.
    const facing = [-rotation[0], -rotation[1]];
    for (const d of dots) {
      d.xy = geoDistance(d.lonlat, facing) < Math.PI / 2 - 0.03 ? projection(d.lonlat) : null;
      if (!d.xy) continue;
      const [x, y] = d.xy, rad = radius(d);
      if (!still) {
        const phase = (t / 1800 + d.phase) % 1;
        ctx.beginPath();
        ctx.arc(x, y, rad + phase * 16, 0, 2 * Math.PI);
        ctx.strokeStyle = `rgba(41, 196, 107, ${0.55 * (1 - phase)})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, rad + 3, 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(41, 196, 107, 0.22)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, 2 * Math.PI);
      ctx.fillStyle = d === hovered ? "#8af5b5" : LIVE;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#111315";
      ctx.stroke();
    }
  }

  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
  function tick(t) {
    if (!alive) return;
    if (focusing) {
      const k = Math.min(1, (t - (focusing.start ??= t)) / 900), e = ease(k);
      rotation = [focusing.from[0] + (focusing.to[0] - focusing.from[0]) * e, focusing.from[1] + (focusing.to[1] - focusing.from[1]) * e, 0];
      if (k === 1) focusing = null;
    } else if (!dragging && !hovered && !still && t > idleUntil) {
      rotation = [rotation[0] + 0.07, rotation[1], 0];
    }
    draw(t);
    // With reduced motion, frames are drawn only while something moves.
    if (!still || focusing || dragging) frame = requestAnimationFrame(tick);
    else frame = 0;
  }
  const wake = () => { if (!frame && alive) frame = requestAnimationFrame(tick); };

  canvas.addEventListener("pointerdown", (e) => {
    dragging = { x: e.clientX, y: e.clientY, from: [...rotation] };
    focusing = null;
    canvas.setPointerCapture(e.pointerId);
    wake();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) {
      const k = 75 / projection.scale();
      rotation = [dragging.from[0] + (e.clientX - dragging.x) * k, Math.max(-75, Math.min(75, dragging.from[1] - (e.clientY - dragging.y) * k)), 0];
      return wake();
    }
    const box = canvas.getBoundingClientRect();
    const px = e.clientX - box.left, py = e.clientY - box.top;
    const near = dots.find((d) => d.xy && Math.hypot(d.xy[0] - px, d.xy[1] - py) < radius(d) + 7) ?? null;
    if (near !== hovered) {
      hovered = near;
      wake();
    }
    onHover?.(near, near ? near.xy[0] : 0, near ? near.xy[1] : 0);
  });
  const release = () => {
    dragging = null;
    idleUntil = performance.now() + 2500;
    wake();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => {
    if (hovered) {
      hovered = null;
      onHover?.(null);
      wake();
    }
  });

  const observer = new ResizeObserver(() => {
    resize();
    wake();
    if (still) draw(performance.now());
  });
  observer.observe(canvas);
  resize();
  wake();

  return {
    // rows: [{ label: country code, v: visitors }]
    update(rows) {
      const before = new Map(dots.map((d) => [d.code, d.phase]));
      dots = rows.filter((r) => places.points[r.label]).map((r) => ({
        code: r.label, v: r.v, lonlat: places.points[r.label], phase: before.get(r.label) ?? Math.random(),
      }));
      lit = new Set(dots.map((d) => d.code));
      wake();
      if (still) draw(performance.now());
    },
    // Turns the globe to face a country, the short way round.
    focus(code) {
      const p = places.points[code];
      if (!p) return;
      let lon = -p[0];
      while (lon - rotation[0] > 180) lon -= 360;
      while (lon - rotation[0] < -180) lon += 360;
      focusing = { from: [...rotation], to: [lon, Math.max(-60, Math.min(60, -p[1]))] };
      idleUntil = performance.now() + 4000;
      wake();
    },
    destroy() {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    },
  };
}
