// How to reach the database: DATABASE_URL, and, for a host that signs its databases with a certificate of its own
// (Aiven gives you a ca.pem), DATABASE_CA with that certificate's text, so the connection is encrypted and the
// server checked against it. Line breaks in DATABASE_CA may be written as \n.
import type pg from "pg";

export function dbConfig(connectionString: string, extra: pg.PoolConfig = {}): pg.PoolConfig {
  const ca = process.env.DATABASE_CA?.replace(/\\n/g, "\n").trim();
  if (!ca) return { connectionString, ...extra };
  // The certificate does the checking; an sslmode in the address would replace it.
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true }, ...extra };
}
