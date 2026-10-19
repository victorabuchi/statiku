// Country from an IP, using DB-IP's free country database (CC BY 4.0, https://db-ip.com), read in memory.
// `npm run geo` downloads it to data/country.mmdb.
import { readFileSync } from "node:fs";
import { Reader, type CountryResponse } from "mmdb-lib";

export class Geo {
  reader: Reader<CountryResponse> | null = null;

  constructor(path: string | URL) {
    try {
      this.reader = new Reader<CountryResponse>(readFileSync(path));
    } catch {
      console.warn(`No country database at ${path}; countries stay empty. Run npm run geo.`);
    }
  }

  country(ip: string): string | null {
    if (!this.reader || !ip) return null;
    try {
      return this.reader.get(ip.replace(/^::ffff:/, ""))?.country?.iso_code ?? null;
    } catch {
      return null;
    }
  }
}
