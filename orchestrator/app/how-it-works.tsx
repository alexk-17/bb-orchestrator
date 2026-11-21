// How it works (Home first, 2026-11-20): the one-page guide, USAGE.md, drawn as bb draws Markdown; opened from the ? sheet.
import { Markdown, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract.ts";
import { ReadState } from "./ui.tsx";

export function HowItWorks() {
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "howItWorks", input: null });
  return <div data-how-it-works="" className="[container-type:inline-size]">{q.data ? <Markdown content={q.data.markdown} /> : <ReadState q={q} what="the guide" />}</div>;
}
