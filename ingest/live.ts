// What's happening right now, pushed to the dashboards watching a site: each event as it's collected, each click, and
// a nudge when someone arrives, checks in or leaves. Each carries the visit's tag: a few random-looking letters made
// from the visit's own id, so the live views can follow one visitor from page to page; it's never stored, and says
// nothing about who they are. It lives in this process, which is enough while one instance runs; with several, this
// becomes a shared channel (Redis pub/sub) and presence moves with the sessions.
import { createHash } from "node:crypto";
import type { Session } from "./sessions.ts";

export const tagOf = (sessionId: string) => createHash("sha256").update(`walker:${sessionId}`).digest("base64url").slice(0, 10);

// Who's on the site now and where: a visit's tag, the page it's on, and what the live views show of it.
export const walkersOf = (present: Session[]) =>
  present.map((s) => ({ s: tagOf(s.id), path: s.exitPath, source: s.source, country: s.country, city: s.place?.city ?? null, at: s.lastSeen }));

export type LiveMessage =
  // An event; from a website, also the visitor's city (never stored), what it earned, and whether it began a visit.
  | { t: "event"; e: { ts: Date; name: string; path: string | null; country: string | null; source: string | null; device: string | null; browser: string | null; os: string | null; app: boolean;
      city?: string | null; revenue?: { minor: number; currency: string } | null; first?: boolean; s?: string } }
  | { t: "presence"; s?: string; gone?: boolean }
  // A click on the site: the page, and the text of the link or button.
  | { t: "click"; c: { s: string; path: string; target: string | null; ts: Date } }
  // A number sent with the site's key: for an "add" number, the value is what it went up by.
  | { t: "number"; n: { name: string; value: number | string; ts: Date; kind: "set" | "add" | "text" } };

export class Hub {
  subscribers = new Map<string, Set<(message: string) => void>>();

  subscribe(projectId: string, send: (message: string) => void): () => void {
    let set = this.subscribers.get(projectId);
    if (!set) this.subscribers.set(projectId, (set = new Set()));
    set.add(send);
    return () => {
      set.delete(send);
      if (!set.size) this.subscribers.delete(projectId);
    };
  }

  publish(projectId: string, message: LiveMessage) {
    const set = this.subscribers.get(projectId);
    if (!set) return;
    const text = JSON.stringify(message);
    for (const send of set) send(text);
  }
}
