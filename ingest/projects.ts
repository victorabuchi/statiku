// Projects by their public key, cached for a minute (unknown keys too, so a bad snippet can't hammer the database).
import type pg from "pg";

export type Project = { id: string; key: string; domains: string[] };

const TTL = 60_000;

export class Projects {
  pool: pg.Pool;
  cache = new Map<string, { project: Project | null; at: number }>();

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async byKey(key: string, now = Date.now()): Promise<Project | null> {
    const hit = this.cache.get(key);
    if (hit && now - hit.at < TTL) return hit.project;
    const { rows } = await this.pool.query("select id, key, domains from projects where key = $1", [key]);
    const project: Project | null = rows[0] ?? null;
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(key, { project, at: now });
    return project;
  }
}

// A page may report when its hostname is one of the project's domains or a subdomain of one; www. is ignored.
export function hostAllowed(domains: string[], hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return domains.some((d) => host === d || host.endsWith("." + d));
}

// Domains as stored: lower case, no scheme, path or www.
export function cleanDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "").replace(/^www\./, "");
}
