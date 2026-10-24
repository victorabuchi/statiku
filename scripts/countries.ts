// Writes dashboard/client/countries.json: for each country code, a point on its largest landmass where the live
// globe puts that country's visitors, and the maps' numeric country ids as codes (the detailed map has every id the
// coarse one has). From world-atlas (Natural Earth, public domain). Run after updating world-atlas:
// node scripts/countries.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { geoArea, geoCentroid } from "d3-geo";
import countries from "i18n-iso-countries";
import { feature } from "topojson-client";

const require = createRequire(import.meta.url);
const read = (file: string) => JSON.parse(readFileSync(require.resolve(`world-atlas/${file}`), "utf8"));
// Countries Natural Earth draws without an ISO number, by name.
const UNNUMBERED: Record<string, string> = { Kosovo: "XK" };

const codeOf = (f: { id?: string; properties: { name: string } }) =>
  (f.id && countries.numericToAlpha2(f.id)) || UNNUMBERED[f.properties.name] || null;

const points: Record<string, [number, number]> = {};
const ids: Record<string, string> = {};
const detailed = read("countries-50m.json");
for (const f of (feature(detailed, detailed.objects.countries) as any).features) {
  const code = codeOf(f);
  if (code) ids[f.id ?? f.properties.name] = code;
  if (!code || !f.geometry) continue;
  const parts = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates.map((coordinates: unknown) => ({ type: "Polygon", coordinates })) : [f.geometry];
  const largest = parts.reduce((a: any, b: any) => (geoArea(b) > geoArea(a) ? b : a));
  const [lon, lat] = geoCentroid(largest);
  points[code] = [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100];
}

const out = new URL("../dashboard/client/countries.json", import.meta.url);
writeFileSync(out, JSON.stringify({ points, ids }) + "\n");
console.log(`dashboard/client/countries.json: ${Object.keys(points).length} countries placed, ${Object.keys(ids).length} map ids`);
