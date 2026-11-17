import { saveCopy, type CopyHistory } from "../core/pr-copy-history.ts";
import { copyHistorySchema, rememberPrCopyInput } from "./contract.ts";
import type { z } from "zod";

interface Kv { get<T>(key: string): Promise<T | null | undefined>; set<T>(key: string, value: T): Promise<void> }
export const copyHistoryKey = (login: string) => `prs.copy-history.v1.${login.toLowerCase()}`;

/** Serialize read-modify-write so overlapping section copies can't erase each other's baselines. */
export function createCopyStore(kv: Kv, now = Date.now) {
  let pending: Promise<unknown> = Promise.resolve();
  const read = async (login: string): Promise<CopyHistory> => copyHistorySchema.parse(await kv.get(copyHistoryKey(login)) ?? {});
  const remember = (input: z.infer<typeof rememberPrCopyInput>) => {
    const task = pending.then(async () => {
      const valid = rememberPrCopyInput.parse(input);
      const next = saveCopy(await read(valid.login), valid.prs, valid.section, now());
      // Leave the previous baseline intact if an unusually large list exceeds the SDK's 256 KB KV limit.
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > 240_000) throw new Error("Copy history is too large to save.");
      await kv.set(copyHistoryKey(valid.login), next);
      return next;
    });
    pending = task.catch(() => {});
    return task;
  };
  return { read, remember };
}
