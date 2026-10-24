// Where an IP is, from DB-IP's free databases (CC BY 4.0, https://db-ip.com), read in memory: the country, which is
// stored with each visit, and, when the city database is there, the approximate city, which only places a visitor on
// the live globe while they're on the site and is never stored. `npm run geo` downloads both to data/.
import { existsSync, readFileSync } from "node:fs";
import { Reader, type CityResponse, type CountryResponse } from "mmdb-lib";

export type Place = { city: string; lat: number; lon: number };

export class Geo {
  reader: Reader<CountryResponse | CityResponse> | null = null;
  cities = false;

  // The city database answers countries too, so when it's there the country one isn't loaded.
  constructor(countryPath: string | URL, cityPath?: string | URL) {
    const path = cityPath && existsSync(cityPath) ? cityPath : countryPath;
    try {
      this.reader = new Reader<CountryResponse | CityResponse>(readFileSync(path));
      this.cities = path === cityPath;
    } catch {
      console.warn(`No location database at ${path}; countries stay empty. Run npm run geo.`);
    }
  }

  lookup(ip: string) {
    if (!this.reader || !ip) return null;
    try {
      return this.reader.get(ip.replace(/^::ffff:/, ""));
    } catch {
      return null;
    }
  }

  country(ip: string): string | null {
    return this.lookup(ip)?.country?.iso_code ?? null;
  }

  // The city's centre, to about a kilometre: never the visitor's own position.
  place(ip: string): Place | null {
    if (!this.cities) return null;
    const found = this.lookup(ip) as CityResponse | null;
    const city = found?.city?.names?.en, lat = found?.location?.latitude, lon = found?.location?.longitude;
    if (!city || lat == null || lon == null) return null;
    // The city, not the district: "Dresden (Südvorstadt-West)" is Dresden.
    return { city: city.replace(/\s*\(.*\)$/, ""), lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
  }
}
