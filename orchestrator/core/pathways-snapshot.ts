import type { Pathways } from "../contract.ts";

export type PathwaysSnapshot = { value: Pathways; fetchedAt: number };
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

  const current = (slug: string): PathwaysSnapshot | null => {
    const known = memory.get(slug);
    if (known) return known;
    const durable = deps.read(slug);
    if (durable) memory.set(slug, durable);
    return durable;
  };

  const refresh = (slug: string, load: () => Promise<Pathways>): Promise<Pathways> => {
    const pending = inFlight.get(slug);
    if (pending) return pending;
    const promise: Promise<Pathways> = load().then((value) => {
      if (value.error === null && value.map) {
        const snapshot = { value, fetchedAt: deps.now() };
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
      if (inFlight.get(slug) === promise) inFlight.delete(slug);
    });
    inFlight.set(slug, promise);
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
    async view(slug: string, forced: boolean, load: () => Promise<Pathways>): Promise<PathwaysView> {
      const snapshot = current(slug);
      if (!snapshot || forced) {
        const value = await refresh(slug, load);
        const after = current(slug);
        return after ? shown(slug, after, false) : { ...value, fetchedAt: null, refreshing: false };
      }
      if (isFresh(slug, snapshot)) return shown(slug, snapshot, false);
      void refresh(slug, load);
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
