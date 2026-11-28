import { usageScannerForPlugin } from "../../usage-scan.ts";

const root = process.env.USAGE_SCRATCH;
const session = process.env.USAGE_SESSION;
if (!root || !session) throw new Error("USAGE_SCRATCH and USAGE_SESSION are required");

const bb = {
  storage: { database: () => ({ name: `${root}/data/plugins/usage-meter/data.db` }) },
  sdk: {
    threads: {
      list: async () => [
        {
          id: "thr_api",
          title: "API title",
          titleFallback: null,
          projectId: "proj_1",
          environmentId: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      events: {
        list: async (args: { threadId: string; afterSeq?: string }) =>
          args.threadId === "thr_api" && !args.afterSeq
            ? [{ seq: 1, type: "turn/started", data: { providerThreadId: session } }]
            : [],
      },
    },
  },
};

const scanner = usageScannerForPlugin(bb);
await scanner.scan();
const summary = scanner.summary({ from: 0, to: Date.now() + 60_000, topN: 0 });
scanner.close();
process.stdout.write(JSON.stringify({ threads: summary.byThread.map((bucket) => bucket.label) }));
