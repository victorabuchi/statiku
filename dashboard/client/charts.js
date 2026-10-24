// Charts for the dashboard, drawn as SVG: a line over time with the previous period dashed behind it, sparklines for
// the stat cards, and per-minute bars for the live view. Each has a hover layer, and the line reads out with the
// arrow keys.

const SVG = "http://www.w3.org/2000/svg";
export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

// Round steps for the y axis: 4 or so lines, at 1, 2, 2.5 or 5 times a power of ten.
function nice(max) {
  if (max <= 0) return { top: 4, step: 1 };
  const rough = max / 4, mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= rough);
  return { top: step * Math.ceil(max / step), step };
}

// points: [{ label, v }], compare: the previous period's points by position, or null. m: { label, fmt, tick }.
export function lineChart(host, points, compare, m, names) {
  const W = Math.max(280, host.clientWidth || 800), H = W < 560 ? 200 : 260;
  const M = { l: 44, r: 12, t: 16, b: 26 };
  const values = [...points.map((p) => p.v ?? 0), ...(compare ?? []).map((p) => p.v ?? 0)];
  const { top, step } = nice(Math.max(...values, 0) * 1.08);
  const n = points.length;
  const x = (i) => M.l + (n === 1 ? (W - M.l - M.r) / 2 : (i * (W - M.l - M.r)) / (n - 1));
  const y = (v) => M.t + (H - M.t - M.b) * (1 - (v ?? 0) / top);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", tabindex: "0", "aria-label": `${m.label} over time, ${n} points. Use the arrow keys to read each one.` });
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg.append(svgEl("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), stroke: v === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1, "shape-rendering": "crispEdges" }));
    const t = svgEl("text", { x: M.l - 8, y: y(v) + 4, "text-anchor": "end", class: "axis-text" });
    t.textContent = m.tick(v);
    svg.append(t);
  }
  const every = Math.max(1, Math.ceil(n / (W < 560 ? 4 : 7)));
  for (let i = 0; i < n; i += every) {
    const anchor = i === 0 && n > 1 ? "start" : "middle";
    const t = svgEl("text", { x: x(i), y: H - 6, "text-anchor": anchor, class: "axis-text" });
    t.textContent = points[i].short ?? points[i].label;
    svg.append(t);
  }
  const line = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  if (compare?.length) {
    svg.append(svgEl("path", { d: line(compare.slice(0, n)), fill: "none", stroke: "var(--series-prev)", "stroke-width": 2, "stroke-dasharray": "4 4", "stroke-linejoin": "round", "stroke-linecap": "round" }));
  }
  if (n > 1) {
    svg.append(svgEl("path", { d: `${line(points)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`, fill: "var(--series-wash)" }));
    svg.append(svgEl("path", { d: line(points), fill: "none", stroke: "var(--series)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  } else {
    svg.append(svgEl("circle", { cx: x(0), cy: y(points[0]?.v), r: 4, fill: "var(--series)" }));
  }

  const cross = svgEl("line", { y1: M.t - 4, y2: H - M.b, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" });
  const dot = svgEl("circle", { r: 4.5, fill: "var(--series)", stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" });
  svg.append(cross, dot);
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  let at = n - 1;
  const row = (cls, label, value) => {
    const r = document.createElement("div");
    r.className = "row";
    const i = document.createElement("i");
    if (cls) i.className = cls;
    const span = document.createElement("span");
    span.textContent = label;
    const b = document.createElement("b");
    b.textContent = value;
    r.append(i, span, b);
    return r;
  };
  const show = (i) => {
    at = i;
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(i));
    dot.setAttribute("cy", y(points[i].v));
    dot.setAttribute("visibility", "visible");
    const rows = [row("", points[i].label, m.fmt(points[i].v))];
    if (compare?.[i]) rows.push(row("prev", compare[i].label, m.fmt(compare[i].v)));
    tip.replaceChildren(...rows);
    tip.hidden = false;
    tip.style.left = Math.min(Math.max((x(i) / W) * host.clientWidth, 90), host.clientWidth - 90) + "px";
    tip.style.top = (Math.min(y(points[i].v), y(compare?.[i]?.v ?? 0)) / H) * host.clientHeight + "px";
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
  };
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    show(Math.max(0, Math.min(n - 1, Math.round(((px - M.l) / (W - M.l - M.r)) * (n - 1)))));
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(at));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    show(Math.max(0, Math.min(n - 1, at + (e.key === "ArrowLeft" ? -1 : 1))));
  });
  host.replaceChildren(svg, tip);
  if (names) {
    const legend = document.createElement("div");
    legend.className = "legend";
    for (const [cls, name] of [["", names.current], ["prev", names.previous]]) {
      if (!name || (cls && !compare?.length)) continue;
      const item = document.createElement("span");
      const i = document.createElement("i");
      if (cls) i.className = cls;
      item.append(i, name);
      legend.append(item);
    }
    host.append(legend);
  }
}

// A small line with no axes, for a stat card.
export function sparkline(values, { width = 96, height = 30 } = {}) {
  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true", class: "spark" });
  if (!values.length) return svg;
  const max = Math.max(...values, 1);
  const x = (i) => (values.length === 1 ? width / 2 : 1 + (i * (width - 2)) / (values.length - 1));
  const y = (v) => height - 2 - ((height - 4) * (v ?? 0)) / max;
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  svg.append(svgEl("path", { d: `${d}L${x(values.length - 1)},${height}L${x(0)},${height}Z`, fill: "var(--series-wash)" }));
  svg.append(svgEl("path", { d, fill: "none", stroke: "var(--series)", "stroke-width": 1.6, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  return svg;
}

// Columns for each minute, rounded at the top, with a hover readout.
export function minuteBars(host, points, fmt) {
  const W = Math.max(260, host.clientWidth || 600), H = 150;
  const M = { l: 30, r: 4, t: 10, b: 22 };
  const { top, step } = nice(Math.max(...points.map((p) => p.v), 0));
  const n = points.length, slot = (W - M.l - M.r) / n, bw = Math.max(2, slot - 2);
  const y = (v) => M.t + (H - M.t - M.b) * (1 - v / top);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": `Page views per minute for the last ${n} minutes: ${points.map((p) => `${p.t} ${p.v}`).join(", ")}` });
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg.append(svgEl("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), stroke: v === 0 ? "var(--axis)" : "var(--grid)", "shape-rendering": "crispEdges" }));
    const t = svgEl("text", { x: M.l - 6, y: y(v) + 4, "text-anchor": "end", class: "axis-text" });
    t.textContent = String(v);
    svg.append(t);
  }
  points.forEach((p, i) => {
    const x = M.l + i * slot + (slot - bw) / 2;
    const hgt = Math.max(p.v ? 2 : 0, y(0) - y(p.v));
    const r = Math.min(3, bw / 2, hgt);
    const d = hgt ? `M${x},${y(0)}V${y(0) - hgt + r}Q${x},${y(0) - hgt} ${x + r},${y(0) - hgt}H${x + bw - r}Q${x + bw},${y(0) - hgt} ${x + bw},${y(0) - hgt + r}V${y(0)}Z` : "";
    const g = svgEl("g");
    // A hit area taller than the bar, so even an empty minute shows its readout.
    const hit = svgEl("rect", { x: M.l + i * slot, y: M.t, width: slot, height: H - M.t - M.b, fill: "transparent" });
    const title = svgEl("title");
    title.textContent = `${p.t}: ${fmt(p.v)}`;
    hit.append(title);
    if (d) g.append(svgEl("path", { d, fill: "var(--series)" }));
    g.append(hit);
    svg.append(g);
    if (i % 5 === 0 || i === n - 1) {
      const t = svgEl("text", { x: M.l + i * slot + slot / 2, y: H - 6, "text-anchor": i === n - 1 ? "end" : "middle", class: "axis-text" });
      t.textContent = i === n - 1 ? "now" : p.t;
      svg.append(t);
    }
  });
  host.replaceChildren(svg);
}
