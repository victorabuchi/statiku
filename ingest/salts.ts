// The daily salt behind the visitor hash. Each UTC day gets a random salt; only today's and yesterday's are kept, so
// once a salt is deleted its hashes can't be traced back to an IP or linked to the next day's.
import { createHmac, randomBytes } from "node:crypto";
import type pg from "pg";

const MASK = (1n << 63n) - 1n;

// A keyed hash of the parts as a positive 63-bit number, written as a decimal string for Postgres' bigint.
export function hash63(key: Buffer, ...parts: string[]): string {
  const digest = createHmac("sha256", key).update(parts.join("\n")).digest();
  return (digest.readBigUInt64BE(0) & MASK).toString();
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export class Salts {
  pool: pg.Pool;
  day = "";
  key: Buffer | null = null;
  pending = new Map<string, Promise<Buffer>>();

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
}
