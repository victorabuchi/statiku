// Downloads DB-IP's free country database (CC BY 4.0, https://db-ip.com) to data/country.mmdb. It is published monthly;
// early in a month the new file may not be out yet, so last month's is the fallback. Run: npm run geo
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const out = new URL("../data/country.mmdb", import.meta.url);
const month = (offset: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - offset);
  return d.toISOString().slice(0, 7);
};

for (const m of [month(0), month(1)]) {
  const url = `https://download.db-ip.com/free/dbip-country-lite-${m}.mmdb.gz`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`${url}: ${res.status}`);
    continue;
  }
  const data = gunzipSync(Buffer.from(await res.arrayBuffer()));
  mkdirSync(new URL("./", out), { recursive: true });
  writeFileSync(new URL("country.mmdb.tmp", out), data);
  renameSync(new URL("country.mmdb.tmp", out), out);
  console.log(`data/country.mmdb: DB-IP country lite ${m}, ${(data.length / 1e6).toFixed(1)} MB`);
  process.exit(0);
}
console.error("Could not download the country database.");
process.exit(1);
