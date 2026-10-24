// Street names for the visitors who chose to share their exact location: OpenStreetMap's Nominatim, asked at most once
// a second as its usage policy requires, with answers kept in memory for a day. Only the point, rounded to about
// 100 metres, is sent; nothing about the visitor.

export type Street = { street: string | null; area: string | null; city: string | null; region: string | null; country: string | null };
export type Geocoder = (lat: number, lon: number) => Promise<Street | null>;

const DAY = 86400_000;

export const nominatim: Geocoder = async (lat, lon) => {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&addressdetails=1&accept-language=en&lat=${lat}&lon=${lon}`;
  const res = await fetch(url, {
    headers: { "user-agent": `Statiku/1.0 (privacy-first analytics; ${process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "self-hosted"})` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const a = ((await res.json()) as { address?: Record<string, string> }).address ?? {};
  return {
    street: a.road ?? a.pedestrian ?? a.footway ?? a.path ?? null,
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
