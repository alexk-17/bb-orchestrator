// When the mic is live: only on a click (until hung up) or while Space is held. Esc or a second click hangs up.
// Space in a text field types a space, as always.

export type MicState = { call: "off" | "on"; mode: "open" | "hold" | null; spaceDown: boolean };
export type MicAction = "start-open" | "start-hold" | "mic-on" | "mic-off" | "hangup" | null;

const editable = (t: EventTarget | null): boolean => {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  return el.isContentEditable === true || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
};

export function onClick(s: MicState): MicAction {
  return s.call === "on" ? "hangup" : "start-open";
}

export function onKey(s: MicState, e: { type: "keydown" | "keyup"; key: string; repeat?: boolean; target: EventTarget | null }): MicAction {
  if (e.key === "Escape" && e.type === "keydown") return s.call === "on" ? "hangup" : null;
  if (e.key !== " " || editable(e.target)) return null;
  if (e.type === "keydown") {
    if (e.repeat || s.spaceDown) return null;
    if (s.call === "off") return "start-hold";
    return s.mode === "hold" ? "mic-on" : null; // an open-mic call is already live
  }
  return s.call === "on" && s.mode === "hold" ? "mic-off" : null;
}

/** The mic sends audio only in an open call, or in a hold call while Space is down. */
export const micLive = (s: MicState) => s.call === "on" && (s.mode === "open" || s.spaceDown);
