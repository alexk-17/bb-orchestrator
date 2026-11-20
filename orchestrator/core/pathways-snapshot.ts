import type { Pathways } from "../contract.ts";

export type PathwaysSnapshot = { value: Pathways; fetchedAt: number; sourceKey?: string };
export type PathwaysView = Pathways & { fetchedAt: number | null; refreshing: boolean };

export type PathwaysSnapshotDeps = {
  now: () => number;
  maxAgeMs: number;
  read: (slug: string) => PathwaysSnapshot | null;
  write: (slug: string, snapshot: PathwaysSnapshot) => void;
};

export function createPathwaysSnapshots(deps: PathwaysSnapshotDeps) {
  const memory = new Map<string, PathwaysSnapshot>();
  const inFlight = new Map<string, Promise<Pathways>>();
  const refreshErrors = new Map<string, string>();
  const failedAt = new Map<string, number>();
  const stale = new Set<string>();
  const latestSource = new Map<string, string>();

  const current = (slug: string): PathwaysSnapshot | null => {
    const known = memory.get(slug);
    if (known) return known;
    const durable = deps.read(slug);
    if (durable) memory.set(slug, durable);
    return durable;
  };

  const forget = (slug: string) => {
    memory.delete(slug);
    refreshErrors.delete(slug);
    failedAt.delete(slug);
    stale.delete(slug);
  };

  const matchesSource = (snapshot: PathwaysSnapshot | null, sourceKey: string): PathwaysSnapshot | null =>
    snapshot && (snapshot.sourceKey ?? "default") === sourceKey ? snapshot : null;

  const refresh = (slug: string, load: () => Promise<Pathways>, sourceKey: string): Promise<Pathways> => {
    const flightKey = `${slug}::${sourceKey}`;
    const pending = inFlight.get(flightKey);
    if (pending) return pending;
    const promise: Promise<Pathways> = load().then((value) => {
      if (latestSource.get(slug) !== sourceKey) return value;
      if (value.error === null && value.map) {
        const snapshot: PathwaysSnapshot = sourceKey === "default" ? { value, fetchedAt: deps.now() } : { value, fetchedAt: deps.now(), sourceKey };
        memory.set(slug, snapshot);
        deps.write(slug, snapshot);
        refreshErrors.delete(slug);
        failedAt.delete(slug);
      } else {
        refreshErrors.set(slug, value.error ?? "Pathways refresh failed.");
        failedAt.set(slug, deps.now());
      }
      stale.delete(slug);
      return value;
    }).finally(() => {
      if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey);
    });
    inFlight.set(flightKey, promise);
    return promise;
  };

  const shown = (slug: string, snapshot: PathwaysSnapshot, refreshing: boolean): PathwaysView => ({
    ...snapshot.value,
    error: refreshErrors.get(slug) ?? null,
    fetchedAt: snapshot.fetchedAt,
    refreshing,
  });

  const isFresh = (slug: string, snapshot: PathwaysSnapshot) =>
    !stale.has(slug) && deps.now() - Math.max(snapshot.fetchedAt, failedAt.get(slug) ?? 0) < deps.maxAgeMs;

  return {
    async view(slug: string, forced: boolean, load: () => Promise<Pathways>, sourceKey = "default"): Promise<PathwaysView> {
      latestSource.set(slug, sourceKey);
      const existing = current(slug);
      const snapshot = matchesSource(existing, sourceKey);
      if (existing && !snapshot) forget(slug);
      if (!snapshot || forced) {
        const value = await refresh(slug, load, sourceKey);
        const after = matchesSource(current(slug), sourceKey);
        return after ? shown(slug, after, false) : { ...value, fetchedAt: null, refreshing: false };
      }
      if (isFresh(slug, snapshot)) return shown(slug, snapshot, false);
      void refresh(slug, load, sourceKey);
      return shown(slug, snapshot, true);
    },
    peek(slug: string): PathwaysSnapshot | null {
      return current(slug);
    },
    markStale(slug: string): void {
      stale.add(slug);
    },
  };
}
