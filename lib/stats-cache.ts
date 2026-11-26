import { createHash } from "node:crypto";
import { decryptJson, encryptJson } from "./oauth";
import { getRedisClientPromise, withTimeout } from "./ratelimit";

// Cache for get_activity_breakdown (issue #100, ADR 0018), on the same Redis
// as rate limiting. Fail-open like ratelimit.ts: when Redis is unset, slow or
// down, every read is a miss and every write is skipped, and the caller says
// "no cache" in its output.
//
// Privacy:
// - Keys are SHA-256 hashes, so repository names and SHAs never appear in
//   Redis keys.
// - Commit and PR stats store numbers only (lines added/removed, files
//   changed count): no file names, no content.
// - Discovery lists (which commits/PRs a login authored in a time slice)
//   contain repository names, so they are encrypted with the server key and
//   keyed by login; they are only read back for that same login, i.e. for a
//   session whose token GitHub verified as that account.

const COMMAND_TIMEOUT_MS = 1500;
const CONNECT_TIMEOUT_MS = 1000;

export type Stats = { additions: number; deletions: number; files: number };

function key(kind: string, ...parts: string[]): string {
  return `st:${kind}:${createHash("sha256").update(parts.join("\u0000")).digest("base64url")}`;
}

export const commitStatsKey = (repo: string, sha: string) => key("c", repo, sha);
export const prStatsKey = (repo: string, n: number) => key("p", repo, String(n));
export const discoveryKey = (login: string, kind: string, owner: string, from: string, to: string) =>
  key("d", login.toLowerCase(), kind, owner.toLowerCase(), from, to);

async function client() {
  const p = getRedisClientPromise();
  if (!p) return null;
  return withTimeout(p, CONNECT_TIMEOUT_MS);
}

export class StatsCache {
  available = true;
  hits = 0;
  writes = 0;

  private async run<T>(fn: (c: NonNullable<Awaited<ReturnType<typeof client>>>) => Promise<T>, fallback: T): Promise<T> {
    if (!this.available) return fallback;
    try {
      const c = await client();
      if (!c) {
        this.available = false;
        return fallback;
      }
      return await withTimeout(fn(c), COMMAND_TIMEOUT_MS);
    } catch (err) {
      console.error("[stats-cache] redis unavailable, continuing without cache:", err);
      this.available = false;
      return fallback;
    }
  }

  async getStats(keys: string[]): Promise<(Stats | null)[]> {
    if (!keys.length) return [];
    const raw = await this.run((c) => c.mGet(keys), keys.map(() => null) as (string | null)[]);
    return raw.map((v) => {
      if (!v) return null;
      const [a, d, f] = v.split(",").map(Number);
      if ([a, d, f].some((n) => !Number.isFinite(n))) return null;
      this.hits += 1;
      return { additions: a, deletions: d, files: f };
    });
  }

  async setStats(entries: [string, Stats][]): Promise<void> {
    if (!entries.length) return;
    const ok = await this.run(async (c) => {
      await c.mSet(entries.map(([k, s]) => [k, `${s.additions},${s.deletions},${s.files}`] as [string, string]));
      return true;
    }, false);
    if (ok) this.writes += entries.length;
  }

  async getDiscovery<T>(k: string): Promise<T | null> {
    const v = await this.run((c) => c.get(k), null as string | null);
    if (!v) return null;
    try {
      return decryptJson<T>(v);
    } catch {
      return null;
    }
  }

  async setDiscovery(k: string, value: unknown, ttlSeconds: number): Promise<void> {
    let blob: string;
    try {
      blob = encryptJson(value);
    } catch {
      return; // no encryption key configured: do not store discovery lists in clear
    }
    await this.run(async (c) => {
      await c.set(k, blob, { EX: ttlSeconds });
      return true;
    }, false);
  }
}
