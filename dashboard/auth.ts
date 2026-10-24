// Accounts and sign-ins for the dashboard. Passwords are hashed with scrypt. A sign-in is a random token kept in an
// HttpOnly cookie and stored here only as its SHA-256 hash; it lasts 30 days. This cookie is for people signed in to
// Statiku itself, never for the visitors of the sites it counts.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type pg from "pg";

export const COOKIE = "stk_session";
const LOGIN_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export type User = { id: string; email: string; name: string; avatarAt: Date | null };

const derive = (password: string, salt: Buffer, length: number) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, length, SCRYPT, (e, key) => (e ? reject(e) : resolve(key))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${(await derive(password, salt, 64)).toString("base64")}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, key] = stored.split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  return timingSafeEqual(await derive(password, Buffer.from(salt, "base64"), expected.length), expected);
}

// Checked against when an email has no account, so a wrong email takes as long as a wrong password.
const NOBODY = hashPassword(randomBytes(12).toString("hex"));

export const cleanEmail = (email: unknown) => (typeof email === "string" ? email.trim().toLowerCase().slice(0, 254) : "");
export const emailLooksRight = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const tokenHash = (token: string) => createHash("sha256").update(token).digest();

export async function createUser(pool: pg.Pool, name: string, email: string, password: string): Promise<User | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: [user] } = await client.query(
      `insert into users (email, name, password_hash) values ($1, $2, $3) on conflict (email) do nothing
       returning id, email, name, avatar_at as "avatarAt"`,
      [email, name, await hashPassword(password)],
    );
    if (!user) {
      await client.query("rollback");
      return null;
    }
    // Everyone starts with a workspace of their own, where the sites they add go.
    const { rows: [workspace] } = await client.query("insert into workspaces (name) values ($1) returning id", [name]);
    await client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspace.id, user.id]);
    await client.query("commit");
    return user;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function findByPassword(pool: pg.Pool, email: string, password: string): Promise<User | null> {
  const { rows: [row] } = await pool.query(`select id, email, name, avatar_at as "avatarAt", password_hash from users where email = $1`, [email]);
  const ok = await checkPassword(password, row?.password_hash ?? (await NOBODY));
  return row && ok ? { id: row.id, email: row.email, name: row.name, avatarAt: row.avatarAt } : null;
}

export async function startLogin(pool: pg.Pool, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    "insert into logins (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))",
    [tokenHash(token), userId, LOGIN_DAYS],
  );
  // Expired sign-ins are cleared now and then, as new ones start.
  if (Math.random() < 0.05) await pool.query("delete from logins where expires_at < now()");
  return token;
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

export async function userOf(pool: pg.Pool, req: IncomingMessage): Promise<User | null> {
  const token = cookies(req)[COOKIE];
  if (!token) return null;
  const { rows: [user] } = await pool.query(
    `select u.id, u.email, u.name, u.avatar_at as "avatarAt" from logins l join users u on u.id = l.user_id
      where l.token_hash = $1 and l.expires_at > now()`,
    [tokenHash(token)],
  );
  return user ?? null;
}

export async function endLogin(pool: pg.Pool, req: IncomingMessage) {
  const token = cookies(req)[COOKIE];
  if (token) await pool.query("delete from logins where token_hash = $1", [tokenHash(token)]);
}

// A new password, which also signs out every other browser.
export async function changePassword(pool: pg.Pool, req: IncomingMessage, userId: string, password: string) {
  await pool.query("update users set password_hash = $2 where id = $1", [userId, await hashPassword(password)]);
  const token = cookies(req)[COOKIE];
  await pool.query("delete from logins where user_id = $1 and token_hash <> $2", [userId, token ? tokenHash(token) : Buffer.alloc(0)]);
}

// A forgotten password: a link that works once, for an hour, mailed to the account's address. Asking again makes the
// earlier links stop working. Null when there's no account with that email, which the caller doesn't reveal.
const RESET_MINUTES = 60;
export async function startReset(pool: pg.Pool, email: string): Promise<{ user: User; token: string } | null> {
  const { rows: [user] } = await pool.query(`select id, email, name, avatar_at as "avatarAt" from users where email = $1`, [email]);
  if (!user) return null;
  const token = randomBytes(32).toString("base64url");
  await pool.query("delete from password_resets where user_id = $1 or expires_at < now()", [user.id]);
  await pool.query(
    "insert into password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(mins => $3))",
    [tokenHash(token), user.id, RESET_MINUTES],
  );
  return { user, token };
}

// Whose reset link this is, if it still works.
export async function resetFor(pool: pg.Pool, token: string): Promise<User | null> {
  const { rows: [user] } = await pool.query(
    `select u.id, u.email, u.name, u.avatar_at as "avatarAt" from password_resets r join users u on u.id = r.user_id
      where r.token_hash = $1 and r.expires_at > now() and r.used_at is null`,
    [tokenHash(token)],
  );
  return user ?? null;
}

// The new password: the link is used up, and every browser signed in to the account is signed out.
export async function finishReset(pool: pg.Pool, token: string, password: string): Promise<User | null> {
  const { rows: [row] } = await pool.query(
    "update password_resets set used_at = now() where token_hash = $1 and expires_at > now() and used_at is null returning user_id",
    [tokenHash(token)],
  );
  if (!row) return null;
  await pool.query("update users set password_hash = $2 where id = $1", [row.user_id, await hashPassword(password)]);
  await pool.query("delete from logins where user_id = $1", [row.user_id]);
  const { rows: [user] } = await pool.query(`select id, email, name, avatar_at as "avatarAt" from users where id = $1`, [row.user_id]);
  return user;
}

// Closing an account: the workspaces only this person was in go with it, with their sites and everything they
// collected; workspaces shared with others stay.
export async function deleteAccount(pool: pg.Pool, userId: string, deleteSite: (site: { id: string; key: string }) => Promise<void>) {
  const { rows: alone } = await pool.query(
    `select m.workspace_id from memberships m
      where m.user_id = $1 and not exists (select 1 from memberships o where o.workspace_id = m.workspace_id and o.user_id <> $1)`,
    [userId],
  );
  const ids = alone.map((r) => r.workspace_id);
  const { rows: sites } = await pool.query("select id, key from projects where workspace_id = any($1)", [ids]);
  for (const site of sites) await deleteSite(site);
  await pool.query("delete from workspaces where id = any($1)", [ids]);
  await pool.query("delete from users where id = $1", [userId]);
}

// Secure only over HTTPS, so signing in works on http://localhost too.
export const loginCookie = (token: string, secure: boolean) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_DAYS * 86400}${secure ? "; Secure" : ""}`;
export const clearedCookie = (secure: boolean) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

// At most `limit` tries per key (an IP address, in memory only) in a window; enough for typos, not for guessing.
export class Attempts {
  limit: number;
  windowMs: number;
  seen = new Map<string, { count: number; until: number }>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): boolean {
    const entry = this.seen.get(key);
    if (!entry || entry.until < now) {
      if (this.seen.size > 50_000) this.seen.clear();
      this.seen.set(key, { count: 1, until: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}
