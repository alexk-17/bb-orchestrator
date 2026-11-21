// Standing rules from the owner's answers (2026-11-16). Two pure parts, no model and no clock:
// - `sameWay` spots cards the owner answered the same way, so the CoS can be offered a rule (a false offer costs one
//   CoS turn and, at most, one "Make this a rule?" card the owner declines);
// - `matchRule` decides whether a rule settles a new card. A false match settles something the owner should have seen,
//   so it misses on anything doubtful: every word must be there, exactly one option must carry the answer's words, and
//   some cards (merges, plans, sign-ins, anything touching production or money) are never settled by a rule at all.
import type { Decision } from "./model.ts";

/** What a rule matches: who asks, the words its title and question must hold, and the option that is its answer. */
export interface RuleMatch {
  /** Addresses whose cards it covers (the card's origin or asker); a trailing * matches a prefix ("thread:alpha:*"). */
  from: string[];
  /** Every one must appear as a word in the card's title or question; a trailing * matches a word's start ("recreat*"). */
  words: string[];
  /** None may appear anywhere on the card (title, question, context, any option). */
  without: string[];
  /** The card's dedupe key must start with this, when set. */
  key_prefix: string | null;
  /** The answer: the one option whose label holds all these words. No such option, or two: no match. */
  option: string[];
  /**
   * The stop words this rule lets through, each in one field only: those that stood in that field on one of its
   * evidence cards the owner answered ("billed" in an option's detail). Never in the label of the option it picks. Set by the engine from the evidence, never
   * by the CoS. Absent on a rule made before 2026-11-16's whole-card check: nothing is let through.
   */
  allow?: Allowed[];
}

/** Where on a card a word stands. Options count as one field each for labels and details, whichever option it is. */
export type Field = "title" | "question" | "context" | "label" | "detail";
export interface Allowed {
  word: string;
  field: Field;
}

/** The words in each field of what the asker wrote. */
export function fieldWords(d: Decision): Record<Field, string[]> {
  const r = d.request;
  return {
    title: words(r.title),
    question: words(r.question),
    context: words(r.context ?? ""),
    label: words(r.options.map((o) => o.label).join(" ")),
    detail: words(r.options.map((o) => o.detail ?? "").join(" ")),
  };
}

const FIELDS: Field[] = ["title", "question", "context", "label", "detail"];

/** The stop words the owner saw in a field of an evidence card and answered anyway: each passes in that field only. */
export function allowFrom(evidence: readonly Decision[]): Allowed[] {
  const each = evidence.map(fieldWords);
  return NEVER_WORDS.filter((w) => !NEVER_EXEMPT.includes(w)).flatMap((word) => FIELDS.filter((field) => each.some((f) => hit(f[field], word))).map((field) => ({ word, field })));
}

/**
 * Words that keep a card from every rule wherever they stand on it (title, question, context, any option's label or
 * detail): a production change, a merge or deploy, data loss, access, or spend. "No production change without the
 * owner's go" can't hang on whether the word lands in a label or a detail. A rule lets one through only in a field
 * where the owner saw it on one of its evidence cards (`allow`), never in the label of the option it picks, and
 * never "prod" or "production" (NEVER_EXEMPT).
 */
export const NEVER_WORDS = ["prod", "production", "merge", "deploy", "delete", "drop", "statsig", "secret", "password", "credential*", "token", "login", "sso", "spend", "billing", "billed", "payment", "customer*"];

/** Never let through, whatever the evidence: a production change needs the owner's explicit go every time. */
export const NEVER_EXEMPT = ["prod", "production"];

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how i if in into is it its it's me my no not of on or our should so that the their them then there these this to too us was we what when which who why will with would yes you your".split(" "),
);

/** Lowercase words, no numbers or stop words: "Recreate 1100's preview" -> ["recreate", "preview"]. */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/'s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !/^[a-z]?\d+[a-z]?$/.test(w) && !STOP.has(w));
}

function hit(ws: readonly string[], w: string): boolean {
  const t = w.toLowerCase().trim();
  if (t.endsWith("*")) {
    const stem = t.slice(0, -1);
    return stem.length > 0 && ws.some((x) => x.startsWith(stem));
  }
  return ws.some((x) => x === t || x === `${t}s`);
}

function fromHit(patterns: readonly string[], addresses: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? addresses.some((a) => a.startsWith(p.slice(0, -1))) : addresses.includes(p)));
}

export type MatchResult = { option: string } | { miss: string };

/** Whether rule `m` settles card `d`, and with which option. Reads only what the asker wrote (`request`), never the CoS's rewording. */
export function matchRule(m: RuleMatch, d: Decision): MatchResult {
  const r = d.request;
  if (d.orchestrator.action === "merge") return { miss: "a merge card" };
  if (d.kind !== "question") return { miss: `a ${d.kind} card` };
  if ((r.blocks ?? []).some((b) => b.kind === "login")) return { miss: "it asks for a sign-in" };
  if (!m.from.length || !m.option.length) return { miss: "the rule names no asker or no answer" };
  if (!fromHit(m.from, [d.orchestrator.origin, d.orchestrator.asker])) return { miss: `it is from ${d.orchestrator.origin}, not ${m.from.join(" or ")}` };
  if (m.key_prefix && !(d.request_key ?? "").startsWith(m.key_prefix)) return { miss: `its key isn't ${m.key_prefix}…` };
  const head = words(`${r.title} ${r.question}`);
  const missing = m.words.filter((w) => !hit(head, w));
  if (missing.length) return { miss: `its title and question don't say ${missing.map((w) => JSON.stringify(w)).join(", ")}` };
  const fits = r.options.filter((o) => m.option.every((w) => hit(words(o.label), w)));
  if (fits.length !== 1) return { miss: fits.length ? `${fits.length} options say ${m.option.join(" ")}` : `no option says ${m.option.join(" ")}` };
  // The floor reads the whole card, field by field; a stop word passes only in a field the rule's evidence had it in,
  // and never in the label of the option the rule picks: that is what it approves.
  const pick = fits[0]!;
  const f = fieldWords(d);
  const picked = NEVER_WORDS.filter((w) => hit(words(pick.label), w)).map((w) => `${JSON.stringify(w.replace(/\*$/, ""))} in the option it picks`);
  if (picked.length) return { miss: `it mentions ${picked.join(", ")}` };
  const allowed = (m.allow ?? []).filter((a) => !NEVER_EXEMPT.includes(a.word));
  const floor = NEVER_WORDS.flatMap((w) => FIELDS.filter((field) => hit(f[field], w) && !allowed.some((a) => a.word === w && a.field === field)).map((field) => `${JSON.stringify(w.replace(/\*$/, ""))} in the ${field}`));
  if (floor.length) return { miss: `it mentions ${[...new Set(floor)].join(", ")}` };
  const all = FIELDS.flatMap((field) => f[field]);
  const banned = m.without.filter((w) => hit(all, w));
  if (banned.length) return { miss: `it mentions ${banned.map((w) => JSON.stringify(w.replace(/\*$/, ""))).join(", ")}` };
  return { option: pick.id };
}

// ---------------------------------------------------------------- offers: cards answered the same way

/** A card the owner answered with an option, as the offer compares it. */
export interface Shape {
  id: string;
  group: string; // the project, or the asker for a card with none (the orchestrator's own, the Steward's)
  stem: string | null; // the dedupe key without its trailing numbers or date
  chosenId: string;
  chosen: string; // the chosen label, lowercased, numbers dropped
  chosenWords: string[];
  otherWords: string[];
  text: string[]; // the words of its title, question and option labels, plurals folded
}

/**
 * The asker's option the owner picked. The answer's id is the CoS's card, which may reorder, reword or drop the asker's
 * options (11-14: "Archive, list the kept IDs" was the CoS's option 1 and the asker's option 2). So it is tied back by
 * label: the same label, else the one asker option sharing words with it. Null when no option can be told: such a card
 * is no evidence, and no rule may match it.
 */
export function ownerPick(d: Decision): string | null {
  const a = d.answer;
  if (!a?.option) return null;
  const shown = (d.ask?.options ?? d.request.options).find((o) => o.id === a.option);
  if (!shown) return null;
  if (!d.ask) return shown.id;
  const norm = (l: string) => words(l.replace(/\(recommended\)/gi, "")).join(" ");
  const same = d.request.options.filter((o) => norm(o.label) === norm(shown.label));
  if (same.length === 1) return same[0]!.id;
  const want = words(shown.label.replace(/\(recommended\)/gi, "")).map(fold);
  const scored = d.request.options.map((o) => ({ id: o.id, n: overlap(words(o.label).map(fold), want).length })).sort((x, y) => y.n - x.n);
  return scored[0] && scored[0].n > 0 && scored[0].n > (scored[1]?.n ?? 0) ? scored[0].id : null;
}

export function shapeOf(d: Decision): Shape | null {
  const a = d.answer;
  if (!a || a.by !== "person" || a.via === "merged" || !a.option || d.kind !== "question" || d.orchestrator.action === "merge" || d.orchestrator.rule_proposal || d.orchestrator.board_review) return null;
  const pickId = ownerPick(d);
  const own = d.request.options.find((o) => o.id === pickId);
  if (!own) return null;
  const pick = (d.ask?.options ?? d.request.options).find((o) => o.id === a.option)!;
  const label = own.label;
  const stem = d.request_key ? d.request_key.replace(/([-_:.]*\d+)+$/, "") || null : null;
  return {
    id: d.id,
    group: d.project !== null ? `project:${d.project}` : `asker:${d.orchestrator.origin}`,
    stem,
    chosenId: own.id,
    chosen: words(label.replace(/\(recommended\)/i, "")).join(" "),
    chosenWords: words(`${label} ${pick.label}`.replace(/\(recommended\)/gi, "")),
    otherWords: words(d.request.options.filter((o) => o.id !== own.id).map((o) => o.label).join(" ")),
    text: [...new Set(words(`${d.request.title} ${d.request.question} ${d.request.options.map((o) => o.label).join(" ")}`).map(fold))],
  };
}

const fold = (w: string) => w.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : "")).replace(/(ing|ed)$/, "");
/** Words any answer might hold ("Go now", "Accept both"): sharing one says nothing about answering the same way. */
const ANY_ANSWER = new Set("now go ok okay both only all one first later wait after before keep leave use accept include approve allow just again new still also".split(" "));
const choiceWords = (ws: readonly string[]) => ws.filter((w) => !ANY_ANSWER.has(w));
const overlap = (a: readonly string[], b: readonly string[]) => a.filter((w) => b.includes(w));
/** How much of the shorter card the longer one shares: short titles aren't drowned by a long question. */
function shared(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  return n === 0 ? 0 : overlap(a, b).length / n;
}

/** The share of words two cards need in common to count as the same question (tuned on 11-13..11-16's cards). */
export const SIMILAR = 0.2;

/**
 * Two cards answered the same way: one asker group, the same choice (the same label, a label word in common, or both
 * the recommended option over alternatives that share a word, like "accept it as blocked"), and a similar question
 * (the same key stem, or titles and questions with words in common).
 */
export function sameWay(a: Shape, b: Shape): boolean {
  if (a.group !== b.group) return false;
  const sameKey = a.stem !== null && a.stem === b.stem;
  const choice = a.chosen === b.chosen || overlap(choiceWords(a.chosenWords), b.chosenWords).length > 0 || (a.chosenId === "1" && b.chosenId === "1" && overlap(choiceWords(a.otherWords), b.otherWords).length > 0);
  if (!choice) return false;
  return sameKey || shared(a.text, b.text) >= SIMILAR;
}

/** The evidence for an offer: the newest card and the earlier ones answered its way (2 with the same key and label, else 3). */
export function offerFor(newest: Shape, earlier: readonly Shape[]): Shape[] | null {
  const like = earlier.filter((s) => s.id !== newest.id && sameWay(newest, s));
  const strong = like.filter((s) => s.stem !== null && s.stem === newest.stem && s.chosen === newest.chosen);
  if (like.length >= 2) return [...like, newest];
  if (strong.length >= 1) return [...strong, newest];
  return null;
}
