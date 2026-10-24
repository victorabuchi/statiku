// The live view's globe: the world on a canvas, turning slowly, with a glowing dot for the visitors on the site right
// now, sized by how many. Zoomed out, there's a dot per country; zoom in (scroll, pinch, the buttons, or tap a country)
// and they split into cities, named once there's room. A visitor's city is approximate, from their IP address, and
// sits at the city's centre: Statiku never knows a street. Map data: world-atlas (Natural Earth); a finer map is
// fetched the first time someone zooms in.
import { geoArea, geoBounds, geoCentroid, geoContains, geoDistance, geoGraticule10, geoOrthographic, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import coarse from "world-atlas/countries-110m.json";
import places from "./countries.json";

const LIVE = "#29c46b";
const MAX_ZOOM = 60;
// Past this zoom, visitors show by city, and the finer map is used.
const CITY_ZOOM = 2.6;
// Past this one, cities are named.
const LABEL_ZOOM = 4.5;

const toMap = (topo) => ({
  countries: feature(topo, topo.objects.countries).features,
  borders: mesh(topo, topo.objects.countries, (a, b) => a !== b),
});
const codeOf = (f) => places.ids[f.id ?? f.properties?.name] ?? null;
// A country's main landmass: France without Guiana, the US without Alaska.
function mainland(f) {
  if (f.geometry?.type !== "MultiPolygon") return f;
  const parts = f.geometry.coordinates.map((coordinates) => ({ type: "Polygon", coordinates }));
  return parts.reduce((a, b) => (geoArea(b) > geoArea(a) ? b : a));
}

export function createGlobe(canvas, { onHover, onView } = {}) {
  const ctx = canvas.getContext("2d");
  // The land is drawn into a layer of its own, again only when the view changes; each frame copies it and adds the dots.
  const layer = document.createElement("canvas");
  const lctx = layer.getContext("2d");
  const projection = geoOrthographic().clipAngle(90).precision(0.5);
  const path = geoPath(projection, lctx);
  const graticule = geoGraticule10();
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let map = toMap(coarse), detailed = null, fetching = false;
  let rotation = [-15, -32, 0], zoom = 1;
  let countries = [], cities = [], lit = new Set();
  let dots = [];
  let focus = { country: null, city: null };
  let size = { w: 0, h: 0, dpr: 1 };
  let dragging = null, hovered = null, flying = null, idleUntil = 0, frame = 0, alive = true, layerKey = "";
  const pointers = new Map();

  const baseScale = () => Math.max(60, Math.min(size.w * 0.42, (size.h - 100) / 2));
  const radius = (d) => 3.5 + Math.sqrt(d.v) * (d.city ? 2 : 2.4);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = { w: canvas.clientWidth, h: canvas.clientHeight, dpr };
    for (const c of [canvas, layer]) {
      c.width = Math.round(size.w * dpr);
      c.height = Math.round(size.h * dpr);
    }
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layerKey = "";
  }

  async function loadDetail() {
    if (detailed || fetching) return;
    fetching = true;
    try {
      detailed = toMap(await (await fetch("/geo/countries-50m.json")).json());
      layerKey = "";
      wake();
    } catch {
      fetching = false;
    }
  }

  function drawLayer() {
    const { w, h } = size;
    const shown = zoom >= CITY_ZOOM && detailed ? detailed : map;
    const key = `${rotation.map((r) => r.toFixed(2))}|${zoom.toFixed(3)}|${w}x${h}|${[...lit]}|${shown === detailed}|${focus.country}`;
    if (key === layerKey) return;
    layerKey = key;
    projection.rotate(rotation).translate([w / 2, (h - 20) / 2 + 6]).scale(baseScale() * zoom).clipExtent([[0, 0], [w, h]]);
    const [cx, cy] = projection.translate(), r = projection.scale();
    lctx.clearRect(0, 0, w, h);
    if (r < Math.max(w, h)) {
      const glow = lctx.createRadialGradient(cx, cy, r * 0.92, cx, cy, r * 1.2);
      glow.addColorStop(0, "rgba(41, 196, 107, 0.12)");
      glow.addColorStop(1, "rgba(41, 196, 107, 0)");
      lctx.fillStyle = glow;
      lctx.beginPath();
      lctx.arc(cx, cy, r * 1.2, 0, 2 * Math.PI);
      lctx.fill();
    }
    const ocean = lctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    ocean.addColorStop(0, "#22303a");
    ocean.addColorStop(1, "#161c22");
    lctx.beginPath();
    path({ type: "Sphere" });
    lctx.fillStyle = ocean;
    lctx.fill();
    lctx.beginPath();
    path(graticule);
    lctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    lctx.lineWidth = 0.6;
    lctx.stroke();
    for (const c of shown.countries) {
      const code = codeOf(c);
      lctx.beginPath();
      path(c);
      lctx.fillStyle = code && code === focus.country ? "#3a7d58" : lit.has(code) ? "#2f6b4b" : "#3b4651";
      lctx.fill();
    }
    lctx.beginPath();
    path(shown.borders);
    lctx.strokeStyle = zoom >= CITY_ZOOM ? "rgba(255, 255, 255, 0.22)" : "rgba(17, 19, 21, 0.75)";
    lctx.lineWidth = zoom >= CITY_ZOOM ? 0.8 : 0.5;
    lctx.stroke();
    lctx.beginPath();
    path({ type: "Sphere" });
    lctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    lctx.lineWidth = 1;
    lctx.stroke();
  }

  // Zoomed out, a dot per country; zoomed in, a dot per city, and one more for each country's visitors whose city
  // isn't known.
  function placeDots() {
    const before = new Map(dots.map((d) => [d.id, d.phase]));
    let list;
    if (zoom < CITY_ZOOM) {
      list = countries.filter((r) => places.points[r.label]).map((r) => ({ id: r.label, code: r.label, v: r.v, lonlat: places.points[r.label] }));
    } else {
      list = cities.map((c) => ({ id: `${c.country}|${c.city}`, code: c.country, city: c.city, v: c.v, lonlat: [c.lon, c.lat] }));
      for (const r of countries) {
        const placed = cities.filter((c) => c.country === r.label).reduce((sum, c) => sum + c.v, 0);
        if (r.v > placed && places.points[r.label]) list.push({ id: r.label, code: r.label, v: r.v - placed, lonlat: places.points[r.label], unplaced: true });
      }
    }
    dots = list.map((d) => ({ ...d, phase: before.get(d.id) ?? Math.random() }));
  }

  function draw(t) {
    // Not on screen yet (or hidden): nothing to draw into.
    if (!layer.width || !layer.height) return;
    drawLayer();
    const { w, h, dpr } = size;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const facing = [-rotation[0], -rotation[1]];
    const labels = [];
    for (const d of dots) {
      const xy = geoDistance(d.lonlat, facing) < Math.PI / 2 - 0.02 ? projection(d.lonlat) : null;
      d.xy = xy && xy[0] > -20 && xy[0] < w + 20 && xy[1] > -20 && xy[1] < h + 20 ? xy : null;
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
      ctx.fillStyle = d === hovered ? "#8af5b5" : d.unplaced ? "rgba(41, 196, 107, 0.55)" : LIVE;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#111315";
      ctx.stroke();
      if (zoom >= LABEL_ZOOM && d.city) labels.push(d);
    }
    // City names with their counts, each on a dark halo: the busiest first, to the right of the dot or else to the
    // left, and left off where it would cover another name.
    ctx.font = "600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const taken = [];
    for (const d of labels.sort((a, b) => b.v - a.v)) {
      const text = `${d.city} · ${d.v}`, width = ctx.measureText(text).width, rad = radius(d), y = d.xy[1];
      for (const x of [d.xy[0] + rad + 7, d.xy[0] - rad - 7 - width]) {
        const box = [x - 3, y - 9, x + width + 3, y + 9];
        if (taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        taken.push(box);
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(17, 19, 21, 0.85)";
        ctx.strokeText(text, x, y);
        ctx.fillStyle = "#fff";
        ctx.fillText(text, x, y);
        break;
      }
    }
  }

  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
  function tick(t) {
    if (!alive) return;
    if (flying) {
      const k = Math.min(1, (t - (flying.start ??= t)) / 1000), e = ease(k);
      rotation = [flying.from[0] + (flying.to[0] - flying.from[0]) * e, flying.from[1] + (flying.to[1] - flying.from[1]) * e, 0];
      setZoom(flying.fromZoom * (flying.toZoom / flying.fromZoom) ** e, true);
      if (k === 1) flying = null;
    } else if (!dragging && !hovered && !still && zoom === 1 && !focus.country && t > idleUntil) {
      rotation = [rotation[0] + 0.07, rotation[1], 0];
    }
    draw(t);
    // With reduced motion, frames are drawn only while something moves.
    if (!still || flying || dragging) frame = requestAnimationFrame(tick);
    else frame = 0;
  }
  const wake = () => {
    if (!frame && alive) frame = requestAnimationFrame(tick);
    if (still && !frame) draw(performance.now());
  };

  function setZoom(next, flight = false) {
    const before = zoom >= CITY_ZOOM;
    zoom = Math.max(1, Math.min(MAX_ZOOM, next));
    if (zoom >= CITY_ZOOM - 0.6) loadDetail();
    if (before !== zoom >= CITY_ZOOM) placeDots();
    // Zoomed back out to the whole world: the country or city in focus is let go.
    if (!flight && zoom < 1.5 && focus.country) setFocus({ country: null, city: null });
  }
  function setFocus(next) {
    focus = next;
    layerKey = "";
    onView?.(focus);
  }
  function flyTo([lon, lat], toZoom) {
    let target = -lon;
    while (target - rotation[0] > 180) target -= 360;
    while (target - rotation[0] < -180) target += 360;
    flying = { from: [...rotation], to: [target, Math.max(-80, Math.min(80, -lat))], fromZoom: zoom, toZoom: Math.max(1, Math.min(MAX_ZOOM, toZoom)) };
    wake();
  }

  function focusCountry(code) {
    const shape = [...(detailed ?? map).countries, ...map.countries].find((f) => codeOf(f) === code);
    const land = shape ? mainland(shape) : null;
    const center = land ? geoCentroid(land) : places.points[code];
    if (!center) return;
    // Zoom until the country fills about two thirds of the globe's height.
    let span = 4;
    if (land) {
      const [[x0, y0], [x1, y1]] = geoBounds(land);
      span = Math.max(((x1 - x0 + 360) % 360) * Math.cos((center[1] * Math.PI) / 180), y1 - y0, 1.5);
    }
    setFocus({ country: code, city: null });
    flyTo(center, 1 / Math.sin((Math.min(80, span * 0.75) * Math.PI) / 180));
  }
  function focusCity(city) {
    setFocus({ country: city.country, city: city.city });
    flyTo([city.lon, city.lat], Math.max(zoom * 2, 40));
  }

  // Pointers: drag to turn, two fingers to pinch, a tap to fly to what's under it.
  const at = (e) => {
    const box = canvas.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top];
  };
  const dotAt = ([px, py]) => dots.find((d) => d.xy && Math.hypot(d.xy[0] - px, d.xy[1] - py) < radius(d) + 7) ?? null;
  canvas.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, at(e));
    canvas.setPointerCapture(e.pointerId);
    flying = null;
    if (pointers.size === 1) dragging = { start: at(e), from: [...rotation], moved: false };
    else dragging = { pinch: [...pointers.values()], fromZoom: zoom, moved: true };
    wake();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, at(e));
    if (dragging?.pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()], [a0, b0] = dragging.pinch;
      setZoom(dragging.fromZoom * (Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.max(1, Math.hypot(a0[0] - b0[0], a0[1] - b0[1]))));
      return wake();
    }
    if (dragging?.start) {
      const [x, y] = at(e);
      const dx = x - dragging.start[0], dy = y - dragging.start[1];
      if (Math.hypot(dx, dy) > 4) dragging.moved = true;
      const k = 75 / projection.scale();
      rotation = [dragging.from[0] + dx * k, Math.max(-85, Math.min(85, dragging.from[1] - dy * k)), 0];
      return wake();
    }
    const near = dotAt(at(e));
    if (near !== hovered) {
      hovered = near;
      wake();
    }
    canvas.style.cursor = near ? "pointer" : "";
    onHover?.(near, near ? near.xy[0] : 0, near ? near.xy[1] : 0);
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    const tap = dragging?.start && !dragging.moved;
    if (pointers.size === 0) dragging = null;
    else if (pointers.size === 1) dragging = { start: [...pointers.values()][0], from: [...rotation], moved: true };
    idleUntil = performance.now() + 3000;
    if (tap) {
      const point = at(e), dot = dotAt(point);
      const city = dot?.city && cities.find((c) => `${c.country}|${c.city}` === dot.id);
      if (city) focusCity(city);
      else if (dot) focusCountry(dot.code);
      else {
        const lonlat = projection.invert(point);
        const land = lonlat && geoDistance(lonlat, [-rotation[0], -rotation[1]]) < Math.PI / 2 && (detailed ?? map).countries.find((f) => geoContains(f, lonlat));
        if (land && codeOf(land)) focusCountry(codeOf(land));
      }
    }
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
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    flying = null;
    setZoom(zoom * Math.exp(-e.deltaY * 0.0015));
    idleUntil = performance.now() + 3000;
    wake();
  }, { passive: false });

  const observer = new ResizeObserver(() => {
    resize();
    wake();
  });
  observer.observe(canvas);
  resize();
  wake();

  return {
    // countryRows: [{ label: country code, v }]; cityRows: [{ country, city, lat, lon, v }]
    update(countryRows, cityRows = []) {
      countries = countryRows;
      cities = cityRows;
      lit = new Set(countryRows.map((r) => r.label));
      layerKey = "";
      placeDots();
      wake();
    },
    focusCountry,
    focusCity,
    zoomBy(factor) {
      flyTo([-rotation[0], -rotation[1]], zoom * factor);
    },
    world() {
      setFocus({ country: null, city: null });
      flyTo([-rotation[0], 25], 1);
    },
    destroy() {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    },
  };
}
