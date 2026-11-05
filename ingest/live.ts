// What's happening right now, pushed to the dashboards watching a site: each event as it's collected, and a nudge
// when someone arrives, checks in or leaves. It lives in this process, which is enough while one instance runs;
// with several, this becomes a shared channel (Redis pub/sub) and presence moves with the sessions.

export type LiveMessage =
  | { t: "event"; e: { ts: Date; name: string; path: string | null; country: string | null; source: string | null; device: string | null; browser: string | null; os: string | null; app: boolean } }
  | { t: "presence" }
  // A number sent with the site's key: for an "add" number, the value is what it went up by.
  | { t: "number"; n: { name: string; value: number; ts: Date; kind: "set" | "add" } };

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
