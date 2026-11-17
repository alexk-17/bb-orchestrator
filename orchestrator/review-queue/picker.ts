import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Entry, QueueState } from "./core.ts";
/** Provider-neutral advisory picker. It receives opaque indexes and numeric facts, never PR prose, URLs or credentials. */
export function pickerPrompt(entries: Entry[]): string {
  return `Choose one CodeRabbit review candidate. Do not use tools, read files, run commands, contact GitHub, or post anything. All needed facts follow. Return ONLY JSON {"index":N}. Prefer exactly one human approval, then ready unreviewed work; use unresolved threads and queue order to break ties.\n${JSON.stringify(entries.map((e, index) => ({ index, approvals: e.facts!.approvals, ci: e.facts!.ci, unresolvedThreads: e.facts!.threads, hasOlderReview: !!e.facts!.lastReview, queuePosition: index })))}`;
}
export function parseChoice(output: string, entries: Entry[]): string | null {
  try {
    const match =
      /^(?:```(?:json)?\s*)?(\{\s*"index"\s*:\s*\d+\s*\})(?:\s*```)?$/.exec(
        output.trim(),
      );
    if (!match) return null;
    const { index } = JSON.parse(match[1]!);
    return Number.isInteger(index) ? (entries[index]?.url ?? null) : null;
  } catch {
    return null;
  }
}
export async function chooseWithProvider(
  bb: BbPluginApi,
  entries: Entry[],
  config: QueueState["config"],
  signal: AbortSignal,
) {
  if (!config.model || !config.projectId || !config.environmentId)
    throw new Error(
      "Model picker needs an explicit model, project and environment",
    );
  signal.throwIfAborted();
  const thread = await bb.sdk.threads.spawn({
    title: "CodeRabbit queue picker",
    projectId: config.projectId,
    environment: { type: "reuse", environmentId: config.environmentId },
    providerId: config.provider,
    model: config.model,
    permissionMode: "accept-edits",
    parentNotifications: "off",
    prompt: pickerPrompt(entries),
    pluginMetadata: { reviewQueuePicker: true },
  });
  try {
    await bb.sdk.threads.wait({
      threadId: thread.id,
      status: "idle",
      timeoutMs: 90_000,
      signal,
    });
    const { output } = await bb.sdk.threads.output({
      threadId: thread.id,
      signal,
    });
    const url = parseChoice(output ?? "", entries);
    return {
      url,
      note: url
        ? `${config.provider} / ${config.model}`
        : "Invalid model answer; deterministic fallback",
    };
  } finally {
    await bb.sdk.threads.stop({ threadId: thread.id }).catch(() => {});
    await bb.sdk.threads.archive({ threadId: thread.id }).catch(() => {});
  }
}
