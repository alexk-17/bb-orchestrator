/** Whether a statement keeps to these item kinds: it names at least one kind, and each kind it names is one of them. */
export function withinKinds(sql: string, kinds: readonly string[]): boolean {
  const named = [...sql.matchAll(/\bkind\s*(?:=\s*'([^']*)'|IN\s*\(([^)]*)\))/gi)].flatMap((m) => (m[1] !== undefined ? [m[1]] : [...m[2]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!)));
  return named.length > 0 && named.every((k) => kinds.includes(k));
}
