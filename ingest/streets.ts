// Addresses for the visitors who chose to share their exact location: OpenStreetMap's Nominatim, asked at most once
// a second as its usage policy requires, with answers kept in memory for a day. Only the point, to about 10 metres,
// is sent; nothing about the visitor.

// What's at a point: its street, and the house number nearest it with how far that building is from the point.
export type Street = {
  street: string | null; number: string | null; numberMetres: number | null;
  area: string | null; city: string | null; region: string | null; country: string | null;
};
export type Geocoder = (lat: number, lon: number) => Promise<Street | null>;

const DAY = 86400_000;

// How far apart two points a short way from each other are, in metres.
export const metres = (lat1: number, lon1: number, lat2: number, lon2: number) =>
  Math.hypot((lat2 - lat1) * 111_320, (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180));

// A shared point said only as exactly as the visitor's device was sure of it: with its house number when the device
// was sure to within 25 metres and the building with that number is that close too, by its street when it was sure
// to within 100, and otherwise not at all (its neighbourhood stands in). No number is better than a wrong one.
const HOUSE = 25, STREET = 100;
// Where the number comes before the street.
const NUMBER_FIRST = new Set(["US", "CA", "GB", "IE", "AU", "NZ", "FR", "LU", "ZA", "SG", "MY", "PH"]);
export function addressOf(s: Street | null | undefined, acc: number | null) {
  if (!s?.street || acc == null || acc > STREET) return null;
  if (!s.number || acc > HOUSE || s.numberMetres == null || s.numberMetres > HOUSE) return s.street;
  return NUMBER_FIRST.has(s.country ?? "") ? `${s.number} ${s.street}` : `${s.street} ${s.number}`;
}

export const nominatim: Geocoder = async (lat, lon) => {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=en&lat=${lat}&lon=${lon}`;
  const res = await fetch(url, {
    headers: { "user-agent": `Statiku/1.0 (privacy-first analytics; ${process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "self-hosted"})` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const found = (await res.json()) as { lat?: string; lon?: string; name?: string; address?: Record<string, string> };
  const a = found.address ?? {};
  const number = a.house_number ?? null;
  return {
    // Off the streets, in a square or a park, the place's own name.
    street: a.road ?? a.pedestrian ?? a.footway ?? a.path ?? (found.name || null),
    number,
    numberMetres: number && found.lat && found.lon ? Math.round(metres(lat, lon, Number(found.lat), Number(found.lon))) : null,
    area: a.neighbourhood ?? a.suburb ?? a.quarter ?? a.city_district ?? null,
    city: a.city ?? a.town ?? a.village ?? a.municipality ?? null,
    region: a.state ?? a.region ?? null,
    country: a.country_code ? a.country_code.toUpperCase() : null,
  };
};

export class Streets {
  geocode: Geocoder;
  known = new Map<string, { at: number; street: Street | null }>();
  waiting: { key: string; lat: number; lon: number }[] = [];
  busy = false;
  onFound: () => void = () => {};

  constructor(geocode: Geocoder = nominatim) {
    this.geocode = geocode;
  }

  // The street at a point if it's known: null when the lookup found none, undefined while it's still being looked up.
  at(lat: number, lon: number): Street | null | undefined {
    const key = `${lat},${lon}`;
    const hit = this.known.get(key);
    if (hit && Date.now() - hit.at < DAY) return hit.street;
    if (!this.waiting.some((w) => w.key === key)) {
      this.waiting.push({ key, lat, lon });
      void this.work();
    }
    return hit?.street;
  }

  async work() {
    if (this.busy) return;
    this.busy = true;
    while (this.waiting.length) {
      const { key, lat, lon } = this.waiting.shift()!;
      const street = await this.geocode(lat, lon).catch(() => null);
      if (this.known.size > 20_000) this.known.clear();
      this.known.set(key, { at: Date.now(), street });
      this.onFound();
      // Nominatim allows one request a second.
      if (this.waiting.length) await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    this.busy = false;
  }
}
