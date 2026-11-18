// The voice's tools. Reads answer from the orchestrator's own state at once. A write is the owner's spoken command: it
// is sent at once by the page, through the owner write it names (contract.ts WRITES), and the voice says what it did in
// one line. Merge, production, money and secrets are the exception: those become a card only a tap sends. Anything the
// Chief of Staff does (start work, triage, chase CI, spin up a project) is asked of the Chief, and its reply read back.
import { z } from "zod";
import { answerBody, approveBody, cosMessageBody, deferBody, directMessageBody, holdBody, priorityBody, requestChangesBody, startLeadBody } from "../contract.ts";
import type { ProposalRoute } from "./contract.ts";
import type { FunctionDeclaration } from "./gemini.ts";
import type { CardLite, DeliverableLite, MessageLite, ProjectLite, WaitLite } from "./snapshot.ts";

/** What the tools read: the orchestrator's state, behind voice/ports.ts. */
export interface VoiceReads {
  board(): { cards: CardLite[]; deferred: CardLite[]; projects: ProjectLite[] };
  card(id: string): (CardLite & { context: string; highStakes: boolean }) | null;
  project(slug: string): { project: ProjectLite; decided: { title: string; answer: string }[]; done: string[] } | null;
  waits(project: string | null): WaitLite[];
  deliverables(project: string | null): DeliverableLite[];
  deliverable(id: string): DeliverableLite | null;
  leadMessages(slug: string): MessageLite[];
}

const s = (description: string) => ({ type: "string", description });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  { name: "board", description: "Everything waiting on the owner now: cards, deferred cards and each project's state." },
  { name: "card", description: "One card in full: its question, options and context.", parameters: obj({ card_id: s("The card id") }, ["card_id"]) },
  { name: "project", description: "One project: its lead's status, step, what it waits on, recent decisions and what is done.", parameters: obj({ project: s("The project slug") }, ["project"]) },
  { name: "prs", description: "Open pull requests the board is waiting on, with their latest checks and review.", parameters: obj({ project: s("A project slug, or empty for all") }) },
  { name: "deliverables", description: "Deliverables, newest first; the ones in review wait on the owner.", parameters: obj({ project: s("A project slug, or empty for all") }) },
  { name: "lead_messages", description: "The latest messages between the owner and a project's lead.", parameters: obj({ project: s("The project slug") }, ["project"]) },
  { name: "show", description: "Scroll the owner's page to a card and highlight it.", parameters: obj({ card_id: s("The card id") }, ["card_id"]) },
  {
    name: "answer_card",
    description: "Answering a card with one of its options (by option id), and optionally a short note.",
    parameters: obj({ card_id: s("The card id"), option: s("The option id, or empty for a note only"), note: s("Optional words to send with it") }, ["card_id"]),
  },
  { name: "defer_card", description: "Putting a card off.", parameters: obj({ card_id: s("The card id"), until: { type: "string", enum: ["1h", "evening", "tomorrow"] } }, ["card_id", "until"]) },
  { name: "tell_lead", description: "Sending the owner's words to a project's lead.", parameters: obj({ project: s("The project slug"), text: s("The message, in the owner's words") }, ["project", "text"]) },
  {
    name: "tell_chief",
    description: "Asking the Chief of Staff to DO something: start or steer work, start a lead or project, triage a card, chase CI, anything beyond these tools. The Chief does it and its reply is read back.",
    parameters: obj({ text: s("The instruction, in the owner's words") }, ["text"]),
  },
  { name: "ask_chief", description: "Ask the Chief of Staff a question (no confirm needed). Its answer comes back later by itself.", parameters: obj({ question: s("The question") }, ["question"]) },
  { name: "approve", description: "Approving a deliverable, optionally with a next step for its lead.", parameters: obj({ deliverable_id: s("The deliverable id"), note: s("Optional note"), next: s("Optional next step") }, ["deliverable_id"]) },
  { name: "request_changes", description: "Asking for changes on a deliverable.", parameters: obj({ deliverable_id: s("The deliverable id"), text: s("What to change") }, ["deliverable_id", "text"]) },
  { name: "set_priority", description: "A project's priority.", parameters: obj({ project: s("The project slug"), priority: { type: "string", enum: ["urgent", "high", "normal", "low"] } }, ["project", "priority"]) },
  { name: "hold", description: "Holding or releasing a project.", parameters: obj({ project: s("The project slug"), held: { type: "boolean" } }, ["project", "held"]) },
  { name: "start_lead", description: "Starting a project's lead.", parameters: obj({ project: s("The project slug") }, ["project"]) },
];

export type ToolOutcome =
  | { kind: "result"; response: Record<string, unknown> }
  | { kind: "show"; cardId: string; response: Record<string, unknown> }
  /** `card`: what a tap card says it will do; `done`: the line said (and shown) once it went through. */
  | { kind: "write"; route: ProposalRoute; body: Record<string, unknown>; card: string; done: string; cardId: string | null; stakes: string[]; awaitChief: boolean }
  | { kind: "ask"; body: Record<string, unknown>; question: string };

const err = (message: string): ToolOutcome => ({ kind: "result", response: { error: message } });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const proj = (v: unknown) => str(v) || null;

/** Body checks against the owner routes' own schemas, so a proposal is never one its route would refuse. */
const BODY: Record<ProposalRoute, z.ZodTypeAny> = {
  answer: answerBody,
  defer: deferBody,
  directMessage: directMessageBody,
  cosMessage: cosMessageBody,
  approve: approveBody,
  requestChanges: requestChangesBody,
  priority: priorityBody,
  hold: holdBody,
  startLead: startLeadBody,
};
export function checkBody(route: ProposalRoute, body: Record<string, unknown>): string | null {
  const r = BODY[route].safeParse(body);
  return r.success ? null : r.error.issues.map((i) => i.message).join("; ");
}

/** Marks the Chief's messages from voice, and asks for an answer that reads well aloud. */
export const chiefText = (text: string, kind: "ask" | "do") =>
  `[voice] ${text.trim()}\n\n(${kind === "ask" ? "A question by voice" : "An instruction by voice, confirmed by the owner"}: answer in at most three short spoken sentences, with no ids or links.)`;

export function route(name: string, args: Record<string, unknown>, reads: VoiceReads, zone: string): ToolOutcome {
  const write = (route: ProposalRoute, body: Record<string, unknown>, card: string, done: string, cardId: string | null, stakes: string[] = [], awaitChief = false): ToolOutcome => {
    const bad = checkBody(route, body);
    return bad ? err(`that isn't a valid ${route} write: ${bad}`) : { kind: "write", route, body, card, done, cardId, stakes: [card, ...stakes], awaitChief };
  };
  switch (name) {
    case "board": {
      const b = reads.board();
      return { kind: "result", response: { cards: b.cards.map((c) => ({ id: c.id, project: c.project, title: c.title })), deferred: b.deferred.map((c) => ({ id: c.id, title: c.title })), projects: b.projects } };
    }
    case "card": {
      const c = reads.card(str(args.card_id));
      return c ? { kind: "result", response: { card: c } } : err(`no open card ${str(args.card_id)}: it may be answered already; check the board`);
    }
    case "project": {
      const p = reads.project(str(args.project));
      return p ? { kind: "result", response: p } : err(`no project ${str(args.project)}`);
    }
    case "prs":
      return { kind: "result", response: { waits: reads.waits(proj(args.project)) } };
    case "deliverables":
      return { kind: "result", response: { deliverables: reads.deliverables(proj(args.project)).slice(0, 20) } };
    case "lead_messages": {
      const slug = str(args.project);
      if (!reads.project(slug)) return err(`no project ${slug}`);
      return { kind: "result", response: { messages: reads.leadMessages(slug).slice(-15) } };
    }
    case "show": {
      const c = reads.card(str(args.card_id));
      return c ? { kind: "show", cardId: c.id, response: { shown: c.id } } : err(`no open card ${str(args.card_id)}`);
    }
    case "answer_card": {
      const c = reads.card(str(args.card_id));
      if (!c) return err(`no open card ${str(args.card_id)}: re-read the board`);
      const optionId = str(args.option) || null;
      const opt = optionId ? c.options.find((o) => o.id === optionId) : null;
      if (optionId && !opt) return err(`card ${c.id} has no option ${optionId}; its options are ${c.options.map((o) => `${o.id}=${o.label}`).join(", ")}`);
      const note = str(args.note) || null;
      if (!opt && !note) return err("pick an option, or say what to write");
      if (!opt && !c.allowText) return err("this card needs one of its options");
      const what = opt ? `option ${opt.id}, ${opt.label}` : "a note";
      return write(
        "answer",
        { id: c.id, rev: c.rev, option: opt?.id ?? null, text: note, via: "voice" },
        `Answer "${c.title}" with ${what}${note ? `, saying: ${note}` : ""}.`,
        `Answered "${c.title}": ${what}${note ? `, "${note}"` : ""}.`,
        c.id,
        [c.title, c.question, ...c.options.map((o) => o.label), c.highStakes ? "secret" : null].filter((x): x is string => !!x),
      );
    }
    case "defer_card": {
      const c = reads.card(str(args.card_id));
      if (!c) return err(`no open card ${str(args.card_id)}`);
      const until = str(args.until);
      if (!["1h", "evening", "tomorrow"].includes(until)) return err("defer for 1h, until evening, or until tomorrow");
      const when = until === "1h" ? "for an hour" : until === "evening" ? "until this evening" : "until tomorrow";
      return write("defer", { id: c.id, rev: c.rev, preset: until, zone, via: "voice" }, `Put off "${c.title}" ${when}.`, `Put off "${c.title}" ${when}.`, c.id);
    }
    case "tell_lead": {
      const slug = str(args.project);
      const text = str(args.text);
      if (!reads.project(slug)) return err(`no project ${slug}`);
      return write("directMessage", { slug, text }, `Tell the ${slug} lead: "${text}".`, `Sent to the ${slug} lead: ${text}`, null, [text]);
    }
    case "tell_chief": {
      const text = str(args.text);
      return write("cosMessage", { text: chiefText(text, "do") }, `Ask the Chief of Staff to: ${text}.`, `Asked the Chief of Staff to: ${text}`, null, [text], true);
    }
    case "ask_chief": {
      const question = str(args.question);
      if (!question) return err("what should I ask the Chief?");
      const body = { text: chiefText(question, "ask") };
      const bad = checkBody("cosMessage", body);
      return bad ? err(bad) : { kind: "ask", body, question };
    }
    case "approve": {
      const d = reads.deliverable(str(args.deliverable_id));
      if (!d || d.state !== "review") return err(`no deliverable ${str(args.deliverable_id)} waiting for review`);
      const note = str(args.note) || null;
      const next = str(args.next) || null;
      return write("approve", { id: d.id, rev: d.rev, note, next }, `Approve "${d.title}"${next ? `, with next step: ${next}` : ""}.`, `Approved "${d.title}"${next ? `; next: ${next}` : ""}.`, null, [d.title, d.summary, note, next].filter((x): x is string => !!x));
    }
    case "request_changes": {
      const d = reads.deliverable(str(args.deliverable_id));
      if (!d || d.state !== "review") return err(`no deliverable ${str(args.deliverable_id)} waiting for review`);
      const text = str(args.text);
      return write("requestChanges", { id: d.id, rev: d.rev, text }, `Ask for changes on "${d.title}": ${text}.`, `Asked for changes on "${d.title}": ${text}`, null, [text]);
    }
    case "set_priority": {
      const slug = str(args.project);
      if (!reads.project(slug)) return err(`no project ${slug}`);
      return write("priority", { slug, priority: str(args.priority) }, `Set ${slug} to ${str(args.priority)} priority.`, `Set ${slug} to ${str(args.priority)} priority.`, null);
    }
    case "hold": {
      const slug = str(args.project);
      if (!reads.project(slug)) return err(`no project ${slug}`);
      const held = args.held === true;
      return write("hold", { slug, held }, `${held ? "Hold" : "Release"} ${slug}.`, `${held ? "Held" : "Released"} ${slug}.`, null);
    }
    case "start_lead": {
      const slug = str(args.project);
      if (!reads.project(slug)) return err(`no project ${slug}`);
      return write("startLead", { slug }, `Start the ${slug} lead.`, `Started the ${slug} lead.`, null);
    }
    default:
      return err(`no tool ${name}`);
  }
}
