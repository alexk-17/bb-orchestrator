export type PathwaysAskResult = { asked: number; failed: { ticketId: string; reason: string }[] };

export async function askPathwaysDecisions<T extends { ticketId: string }>(drafts: readonly T[], ask: (draft: T) => Promise<string | null>): Promise<PathwaysAskResult> {
  const result: PathwaysAskResult = { asked: 0, failed: [] };
  for (const draft of drafts) {
    try {
      const id = await ask(draft);
      if (!id) throw new Error("no decision was filed");
      result.asked++;
    } catch (error) {
      result.failed.push({ ticketId: draft.ticketId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
