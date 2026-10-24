// Downloads DB-IP's free country and city databases (CC BY 4.0, https://db-ip.com) to data/country.mmdb and
// data/city.mmdb. They're published monthly; early in a month the new files may not be out yet, so last month's are
// the fallback. The city database is large (about 130 MB) and only places live visitors on the globe; the service
// works with the country database alone. Run: npm run geo
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const month = (offset: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - offset);
  return d.toISOString().slice(0, 7);
};

let failed = false;
for (const edition of ["country", "city"]) {
  const out = new URL(`../data/${edition}.mmdb`, import.meta.url);
  let done = false;
  for (const m of [month(0), month(1)]) {
    const url = `https://download.db-ip.com/free/dbip-${edition}-lite-${m}.mmdb.gz`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`${url}: ${res.status}`);
      continue;
    }
    const data = gunzipSync(Buffer.from(await res.arrayBuffer()));
    mkdirSync(new URL("./", out), { recursive: true });
    writeFileSync(new URL(`${edition}.mmdb.tmp`, out), data);
    renameSync(new URL(`${edition}.mmdb.tmp`, out), out);
    console.log(`data/${edition}.mmdb: DB-IP ${edition} lite ${m}, ${(data.length / 1e6).toFixed(1)} MB`);
    done = true;
    break;
  }
  if (!done) {
    console.error(`Could not download the ${edition} database.`);
    failed ||= edition === "country";
  }
}
process.exit(failed ? 1 : 0);
