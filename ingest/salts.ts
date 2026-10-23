// The daily salt behind the visitor hash. Each UTC day gets a random salt; only today's and yesterday's are kept, so
// once a salt is deleted its hashes can't be traced back to an IP or linked to the next day's.
import { createHmac, randomBytes } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type pg from "pg";

const MASK = (1n << 63n) - 1n;

// A keyed hash of the parts as a positive 63-bit number, written as a decimal string for Postgres' bigint.
export function hash63(key: Buffer, ...parts: string[]): string {
  const digest = createHmac("sha256", key).update(parts.join("\n")).digest();
  return (digest.readBigUInt64BE(0) & MASK).toString();
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

// The network an address belongs to: an IPv4 address as it is (a home or office shares one), an IPv6 address by its
// /64 prefix, since a Mac's browser and apps can each use a different temporary address inside it.
export function networkOf(ip: string): string {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (isIPv4(v4)) return v4;
  if (!isIPv6(ip)) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export class Salts {
  pool: pg.Pool;
  day = "";
  key: Buffer | null = null;
  pending = new Map<string, Promise<Buffer>>();
  before: { day: string; key: Buffer | null } = { day: "", key: null };

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  // Today's salt. The first call each day creates it (or reads the one another instance made) and drops old ones.
  async forDay(now: Date): Promise<Buffer> {
    const day = utcDay(now);
    if (this.key && this.day === day) return this.key;
    let loading = this.pending.get(day);
    if (!loading) {
      loading = this.load(day).finally(() => this.pending.delete(day));
      this.pending.set(day, loading);
    }
    return loading;
  }

  async load(day: string): Promise<Buffer> {
    await this.pool.query("insert into salts (day, salt) values ($1, $2) on conflict (day) do nothing", [day, randomBytes(32)]);
    const { rows } = await this.pool.query("select salt from salts where day = $1", [day]);
    await this.pool.query("delete from salts where day < $1::date - 1", [day]);
    this.day = day;
    this.key = rows[0].salt as Buffer;
    return this.key;
  }

  // Yesterday's salt, if there was one, for matching a mark made before midnight. It is never created here, and only
  // a salt that was found is kept, so one made late (by a request from just before midnight) is still seen.
  async dayBefore(now: Date): Promise<Buffer | null> {
    const day = utcDay(new Date(now.getTime() - 86400_000));
    if (this.before.day === day) return this.before.key;
    const { rows } = await this.pool.query("select salt from salts where day = $1", [day]);
    if (rows[0]) this.before = { day, key: rows[0].salt };
    return rows[0]?.salt ?? null;
  }
}
