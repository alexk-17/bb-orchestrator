// Layout B's search (2026-11-16): one box beside the filters. It narrows the list to the projects with a hit and lists
// the hits; three letters or more also ask the plugin for older answered cards. (The strip of Needs you, Blocked and
// Changed since you looked that sat under it went on 2026-11-17, the owner: "just remove that row and just rely on the
// filters at the top": the list already says what needs the owner and what is blocked.) 2026-11-17: shadcn's Input and
// Card; a hit's project name is a link Button.
import { useEffect, useState, type ReactNode } from "react";
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Projects } from "../contract.ts";
import { Search } from "lucide-react";
import { INLINE_LINK, ProjectRefs, RefText } from "./ref-text.tsx";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/card.tsx";
import { Input } from "./ui/input.tsx";
import { age } from "./lanes.ts";
import { hitWord, type Hit } from "./source.ts";
import { matchesHead, type TaskHit } from "./kit.ts";

type Project = Projects[number];

export const searchCss = /* css */ `
[data-orch] .orch-cc .top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 16px; margin-bottom: 16px; }
[data-orch] .orch-cc .top .filters { margin: 0; }
[data-orch] .orch-cc .search { flex: 0 1 480px; min-width: 0; }
[data-orch] .orch-cc .hits { margin-bottom: 16px; }
[data-orch] .orch-cc .hits-h { margin: 0 0 4px; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--orch-muted); }
[data-orch] .orch-cc .hits .empty { color: var(--orch-muted); padding-left: 16px; }
[data-orch] .orch-cc .hits .slug { font-weight: 600; margin-right: 4px; }
[data-orch] .orch-cc .hits .ln .tx { max-width: none; }
`;

/** One hit: the project's name, then the words; clicking the name opens the project. */
function Line({ p, onOpen, children, tail, data, title }: { p: Project | undefined; onOpen: (slug: string) => void; children: ReactNode; tail: string; data: string; title: string }) {
  if (!p) return null;
  return (
    <ProjectRefs.Provider value={{ project: p.slug, prs: p.prs ?? [] }}>
      <div className="ln" data-hit-line={data} data-hit-project={p.slug}>
        <span className="tx fit" title={`${p.slug}: ${title}`}>
          <Button variant="link" className={`slug ${INLINE_LINK}`} data-open-project-row={p.slug} onClick={() => onOpen(p.slug)}>
            {p.slug}
          </Button>
          <span className="rest">{children}</span>
        </span>
        <span className="tail">{tail}</span>
      </div>
    </ProjectRefs.Provider>
  );
}

/** The search box: one query over the loaded projects (source.ts searchLoaded), and older answered cards. Esc leaves
 * it with the words kept, as every text box on the page does (keys.ts); the box's own × clears it. */
export function SearchBox({ value, onChange, autoFocus }: { value: string; onChange: (q: string) => void; autoFocus?: boolean }) {
  return (
    <label className="search relative block" data-search="">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" className="pl-9" value={value} placeholder="PR number, ticket id or words" aria-label="Search the projects" data-search-input="" autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

const OLDER_MIN = 3;
/**
 * The value after the owner stops typing for a moment: the plugin is asked once per pause, not per key. The Projects
 * results follow it too (2026-11-20, typing lag): each key used to add and remove result rows, and inside bb's page one
 * element added or removed restyles about 2,700 elements, so typing stuttered.
 */
export function useSettled(v: string, ms = 250): string {
  const [s, setS] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setS(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return s;
}

/** What the search found: the loaded lines by project, then older answered cards from the plugin. */
export function SearchHits({ q, hits, tasks = [], projects, now, onOpen }: { q: string; hits: Hit[]; tasks?: TaskHit[]; projects: Project[]; now: number; onOpen: (slug: string) => void }) {
  const settled = useSettled(q.trim());
  const older = experimental_useRpcQuery({ contract: rpcContract, method: "searchCards", input: { q: settled.slice(0, 80) }, enabled: settled.length >= OLDER_MIN });
  const by = new Map(projects.map((p) => [p.slug, p] as const));
  const cards = settled.length >= OLDER_MIN ? (older.data ?? []) : [];
  return (
    <Card className="hits min-w-0 gap-1 px-4 py-3 shadow-none" data-search-hits={hits.length} data-search-older={cards.length}>
      <h3 className="hits-h">
        {matchesHead(hits.length, tasks.length)}
        {settled.length >= OLDER_MIN ? ` · ${older.data ? older.data.length : "…"} older answered ${older.data?.length === 1 ? "card" : "cards"}` : ""}
      </h3>
      {hits.map((h, i) => (
        <Line key={i} p={by.get(h.project)} onOpen={onOpen} tail={hitWord(h.kind)} data={`hit-${h.kind}`} title={h.text}>
          <RefText text={h.text} exact={h.kind === "pr" || h.kind === "wait" ? h.ref : undefined} />
        </Line>
      ))}
      {/* a scoping task matched by its name: its project is in the list below, opened on it */}
      {tasks.map((t) => (
        <Line key={t.key} p={by.get(t.project)} onOpen={onOpen} tail="scoping task" data="hit-task" title={t.name}>
          {t.name}
        </Line>
      ))}
      {cards.map((c) => (
        <div key={c.id} className="ln" data-search-card={c.id}>
          <span className="tx" title={`${c.title} → ${c.answer}`}>
            {c.project ? <span className="slug">{c.project}</span> : null}
            {c.title} → <b>{c.answer}</b>
          </span>
          <span className="tail">answered {age(c.at, now)} ago</span>
        </div>
      ))}
      {!hits.length && !tasks.length && !cards.length ? <div className="empty">Nothing matches “{q.trim()}”{settled.length >= OLDER_MIN ? " (the newest 2000 answers searched)" : ""}</div> : null}
    </Card>
  );
}
