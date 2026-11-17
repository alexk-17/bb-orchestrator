# Using the Orchestrator

This is a guide to the Orchestrator plugin's page in bb, day to day. To install it, see the [README](../README.md).

Every screenshot here uses made-up projects (kestrel, lynx, otter…) and made-up people (Robin is the owner, Sam is a
colleague).

- [Who does what](#who-does-what)
- [How work moves](#how-work-moves)
- [The page](#the-page)
- [Needs you: answering a card](#needs-you-answering-a-card)
- [Deliverables: reviewing finished work](#deliverables-reviewing-finished-work)
- [Projects: the command center](#projects-the-command-center)
- [Open PRs](#open-prs)
- [Chat, Cloud and Game Boy](#chat-cloud-and-game-boy)
- [Rules: standing answers](#rules-standing-answers)
- [Activity](#activity)
- [Settings that matter](#settings-that-matter)
- [Keyboard shortcuts](#keyboard-shortcuts)

## Who does what

| Role | Who | What it does |
|---|---|---|
| **Owner** | You | You answer cards, review deliverables, and set the direction. You are the only person in the system. |
| **Chief of Staff** (CoS) | A standing agent | Triages every question before it reaches you: settles it from a standing rule, merges it into a duplicate, sends it back to its asker, or puts it to you as a card. It can create projects and start their leads. |
| **Steward** | A standing agent | Watches the machine (disk, memory, swap, CPU). It runs a few allow-listed cleanups on its own, and anything else becomes a card. |
| **Lead** | One agent per project | Plans the project, starts its threads from an approved plan, answers or forwards their questions, and delivers finished work to you. |
| **Thread** | A worker agent | Does one piece of work and reports to its lead. It talks only to its lead. |

Agents are addressed as `cos`, `steward`, `lead:<project>` and `thread:<project>:<n>`. You are not an address: you act
only through this page.

## How work moves

- **Questions go up as cards.** A thread asks its lead. The lead settles the question itself (citing a standing rule,
  or as its own call with a reason) or forwards it to the CoS. The CoS settles it from a rule, or puts it on your
  **Needs you** as a card with 2 to 4 options. If the CoS hasn't triaged a question after `escalateMinutes` (5 by
  default), it reaches you anyway, marked "CoS didn't triage".
- **Answers come back down.** Your answer goes only to the agent that asked. A lead that forwarded a thread's question
  passes the answer on to the thread. The CoS gets a read-only copy of every answer you give on a card.
- **Deliverables go to you.** Threads report to their lead. The lead bundles the work into a deliverable with proof
  (screenshots, checks, a PR) and delivers it to your **Deliverables** tab.
- **You can message a lead directly** from its row on **Projects**. The lead answers with a short note on that row,
  and the CoS gets a copy of both.

A lead never messages you any other way. What you see is cards, deliverables and the notes on direct messages.
Everything else (mail between agents, PR checks, reports) stays in **Activity** until you go looking.

## The page

Open **Orchestrator** in bb's navigation. The tabs are **Deliverables**, **Needs you**, **Chat**, **Projects**,
**Open PRs**, **Cloud**, **Game Boy**, **Rules** and **Activity**. A count on a tab says how many items wait for you
there. The same total shows as a badge on the Orchestrator icon in bb's rail.

- **The box above the tabs** messages the CoS. Type, then **Send** or ⌘/Ctrl+Enter. It lands in the CoS's chat as
  your own message. It is hidden while the Chat tab is open.
- **Split right / Split down** (the two icons at the right of the tabs) open a second pane with another tab. The
  layout is remembered in your browser.

## Needs you: answering a card

![Needs you with two cards](usage-images/needs-you.png)

Each card shows its question, which project and agent it comes from ("via" names the agent that passed it on), and
2 to 4 options. The first option is the recommended one.

- **Click an option** to answer. It goes to the asker at once, and the card is marked "Answered ✓".
- **Other**, when the card allows it, is a text box under the options. Type your own answer and send it with
  ⌘/Ctrl+Enter or **Send**. If you type in it and then click an option, the text goes along as a note with that
  option. Plan cards have no Other box.
- **More** opens the card's context and any extra detail.
- **Defer ▾** takes the card off your list until a time you pick: 1 hour, this evening, tomorrow, or until you bring
  it back. Deferred cards wait under **Deferred**, with **Bring back**.

Labels on a card:

- **Merge**: a request to merge a PR. Only you can answer it; no rule settles it.
- **CoS didn't triage**: it reached you because the CoS ran out of time.
- **Back**: a deferred card that has come back.
- **+N next from …**: that agent has more questions queued behind this one.

An agent can also ask you directly in its own bb thread. Its question shows in the same list, and you can answer it
there; with several questions or several picks, **Send my answers** sends them together. These questions skip the
lead and the CoS: the answer goes straight to the agent, with no copy to the CoS, and they have no Defer. Prompts that
aren't questions are listed under **Waiting on an agent**; click one to open the agent's thread.

**Being triaged by the CoS** lists questions on their way to you, which may still be settled without you.

Some cards are of a special kind:

- **A plan card** is a lead's list of threads it wants to start. Your go starts them. A lead starts threads only from
  an approved plan. If you add a standing rule that covers plans, the CoS may approve one by citing it.
- **"Make this a rule?"** turns answers you keep giving into a standing rule. See [Rules](#rules-standing-answers).

## Deliverables: reviewing finished work

![A deliverable in review](usage-images/deliverable-review.png)

A deliverable is finished work from a lead. It has a one-line summary, then its proof: screenshots and videos inline,
then the findings or decisions, then links, PRs and files under **Details**. Deliverables in review come first,
newest first.

To review one, choose one of three things:

- **Approve.** Leave the **Next move?** box empty and click **Done, nothing more**. It closes, and the lead does
  nothing further.
- **Approve with a next step.** Type the step in **Next move?** ("send the numbers to Sam"). The button becomes
  **Send to lead**. The lead does the step, then closes it with a note, which shows on the deliverable as
  "Next: … → done" with the lead's words.
- **Request changes.** Click **Request changes**, say what to change, then **Send back**. The lead fixes it and
  delivers it again as a new revision. Earlier revisions and your feedback stay under **History**.

### Past deliverables and files

![Past deliverables in the folder view](usage-images/deliverables-past.png)

Below the cards, **Past deliverables** holds everything you have decided on, plus what was withdrawn, as a folder tree:

- one folder per project, in the same order as bb's sidebar;
- in each project, its past deliverables, newest first, each opening to its proof;
- a **Files** folder with the project's outputs that no deliverable used as proof (reports, docs, links its threads
  recorded).

The filters are **All**, **Approved**, **Changes requested**, **Withdrawn** and **Files**. **Files** shows only the
Files folders. You can also pick one project and search titles, summaries and points. Folders on the way to a match
open by themselves.

## Projects: the command center

![Projects, with otter selected](usage-images/projects.png)

On a wide screen, Projects is a list of projects on the left and the selected project on the right.

The list is ordered by what needs attention. Each row shows:

- the project's lead and name;
- one state chip: Blocked, Moving, Waiting, Quiet, On hold or No lead (each with its icon and word);
- how many threads are working;
- the one number that matters most, as a chip: what is for you, else what blocks it, its waits or its PRs;
- how long ago the lead last published its status (amber when old).

Quiet projects sit together below the rest as one dim line each, and archived ones sit behind a toggle. The filters
are **All**, **Needs me**, **Blocked** and **With waits**. The search box finds a project by PR number, ticket id or
words.

The selected project shows, from the top:

- its name, its state and what is for you, with **Timeline** and the **⋯** menu;
- its message box (see below);
- **Pinned**: the documents pinned to it (see below);
- the lead's notes, then its goal with a step meter (and **Ask for status** when the status is old);
- **Lead status**: the lead's last update: a few bullets on what it has been working on, where it is, and what it
  needs, with how long ago it was posted. Leads post one when a thread finishes and at each milestone; each replaces the last;
- **Needs** and **Blocked**, side by side: what waits on you, and what blocks the project;
- **Now**: one card per agent, what it works on, its state, its PR and its context. The first five show, then
  **all N**; idle threads recede;
- **PRs in flight**, each PR once, with what it waits on folded into its row;
- the record: **Done** and **Decided** (your past answers) as two tabs.

**Timeline** opens the project's own page: its timeline, flow and dependencies.

The **⋯** menu pins a document, asks the lead for its status, sets the priority (urgent, high, normal, low), puts the
project on hold or resumes it, and archives it. While a project is on hold, its lead's mail waits and the lead can't
start threads.

The **Standing agents** line above the list shows the CoS and the Steward, with **Start** when one isn't running. On
a narrower screen the same rows make one column, and a tapped row opens its project in place under it.

### Pinned documents

A project keeps up to 12 documents at hand, under its message box: a file, a link or a deliverable. The strip shows
four cards (two per row on a narrower screen), then **+N more**. Each card shows the document's kind, its title and
how fresh it is: a file's last change, a deliverable's latest revision, or when a link was pinned. A click opens it
inside bb: a file in bb's preview, a link through bb, a deliverable on the Deliverables tab. A card's **⋯** opens it,
copies its path or link, or unpins it.

To pin one yourself:

- **⋯ › Pin a document…** or the strip's **+**: paste a file's absolute path, a link or a deliverable id;
- **Pin** on a deliverable in the project's **Done** tab.

A lead pins with `orch_output` and `pin: true` when it records a file or a link, and only in its own project; threads
don't pin. From a terminal:

```
bb orchestrator pin <project> <path|url|deliverable> [--title T]
bb orchestrator unpin <project> <path|url|deliverable|pin id>
```

A file must be inside the project's folders (its lead's worktree, its threads' worktrees, or the shared folders),
checked exactly as proof is; a link must be http or https. A file that is gone, or now resolves somewhere else, shows
"file not found" and doesn't open. A 13th pin is refused: unpin one first.

### Messaging a lead

1. Select the project. Its message box is always open under its name; the project needs a live lead.
2. Type your message, then **Send to lead** (or ⌘/Ctrl+Enter). Tick "a follow-up of your last message" when it
   builds on the one before.
3. The lead answers with a note, shown under your message as "Lead's note". A dot on the project and on the Projects
   tab marks a new note until you open it.

The CoS gets a copy of your message and of the lead's note. For 48 hours your message wins on its point over earlier
or later instructions from the CoS. It is never an approval, though: a merge, a production change or a public push
still needs its own card. If the lead doesn't answer, the message is sent once more after the lead goes idle, then
goes to the CoS as a dead letter.

**Ask for status** (in the ⋯ menu) sends the lead a standard request to publish its status: its goal, its steps
and what it waits on.

### Starting a project and its lead

The simplest way is to ask the CoS, in the box above the tabs or on the Chat tab. Give it:

- a short slug and a title;
- the absolute path of the project's repo on this machine (nothing is cloned);
- the goal, and optionally the base branch, constraints and priority.

The CoS creates the project folder (a `PROJECT.md` and a `project.json` record) in the projects folder (the
`projectsDir` setting). The project then shows on Projects. To make one by hand instead, create the same folder, and
put the repo's absolute path in backticks under a `## Repos` heading in `PROJECT.md`.

Creating a project never starts its lead. Click **Start lead** beside its name, or ask the CoS to start it. Either way, the
same checks run: the project has its folder, a repo under `## Repos` that exists on this machine, isn't on hold, and
has no live lead. The new lead publishes its status, and files a plan card before it starts any threads.

## Open PRs

![Open PRs needing review](usage-images/open-prs.png)

Open PRs lists the open PRs that your GitHub login (`githubLogin`) authored, read through the machine's own `gh` login.
PRs in archived repos are left out, and a read lists at most 250, most recently updated first. It only reads: it never comments, reviews, labels or posts. Each row shows:

- the project and lead, when an orchestrator thread made the PR;
- the review state, CI and mergeability;
- a short summary taken from the PR's description (its TL;DR, else its first paragraph).

**Needs review** shows the PRs that are ready (not drafts), not fully approved, and not failing CI. **All** shows every
PR in the list. Under the list, **Review ask** previews one message for every PR that needs review, with suggested
reviewers, and **Copy** copies it.

![The Post to code reviews preview](usage-images/open-prs-post.png)

**Post to code reviews** shows the exact text with a tick per PR. PRs from `reviewExcludedProjects` start unticked.
The button copies the text and opens your review channel (`reviewChannel`) in Slack. **Post never sends anything by
itself**: you paste and send the message yourself. The plugin has no Slack token.

Suggested reviewers come from the code owners of the changed files, then from people who reviewed the same folders
recently. A reviewer is tagged `@handle` only when `slackHandleMap` maps their GitHub login to it. Everyone else is
shown by their GitHub login, never guessed.

## Chat, Cloud and Game Boy

- **Chat** is the CoS's own bb chat, in a pane. Use it for longer conversations with the CoS.
- **Cloud** shows and switches the AWS profile and gcloud configuration that bb's commands use. Prod targets are never
  one click. Until the machine has a cloud config file, the tab says what to set up. See
  [cloud/README.md](cloud/README.md).
- **Game Boy** plays a ROM you supply, beside your work. See [gameboy/README.md](gameboy/README.md).

## Rules: standing answers

![The Rules tab](usage-images/rules.png)

A standing rule is an answer you've given once that should hold from now on, such as "threads may restart a flaky CI
job once without asking". Rules let questions be settled without reaching you. Rules come from two places.

**Rules you add.** On the Rules tab, give the rule's text, a project (empty means every project), the kinds of card
it covers (question, plan), an optional expiry in days, and where it comes from ("said in chat 2026-11-13"). The CoS,
or a lead within its project, may then settle a card by citing the rule's id (`r-…`). The engine refuses the
citation if the rule is revoked or expired, belongs to another project, or doesn't cover that kind of card. The CoS
can never settle a merge card.

**Rules from your answers.** When you answer similar cards the same way, the CoS can offer you a **Make this a
rule?** card that lists those answers. If you say yes, the rule matches new cards by their words and settles them
itself, without the CoS. The CoS (or, for a thread's question, the lead) is told each time, and the card never
reaches you. A rule made this way never settles a merge, a plan or a sign-in, nor any card that mentions production.
Other risky words (deploy, delete, spend, billing and the like) stop it too, unless the answers it was made from had
that word in the same place on the card.

You can see where a rule settled a card in **Activity → Decisions**: the answer reads "Settled by standing rule
r-…" with the rule's text.

![A card settled by a rule, in Activity](usage-images/activity-decisions.png)

**Revoke** stops a rule at once. Revoked and expired rules stay in the list, greyed out.

## Activity

Activity is the recent record of what the agents did, for when you want to look:

- **Dead letters**: mail nobody took. The CoS handles these, and only the ones it escalates need you.
- **Activity**: deliveries, reports, outputs, PR state changes, direct messages, holds and archives, newest first.
- **Agents**: every agent, with its role, project and state.
- **Decisions**: the latest cards, who each is with now, and how it was answered.

## Settings that matter

Change settings under bb's Settings → Installed plugins → Orchestrator, or from the command line with
`bb plugin config orchestrator set <key> <value>`. The running plugin picks changes up live.

**Notifications**

| Setting | Default | What it does |
|---|---|---|
| `pushNeedsYou` | on | A desktop or web push when a card enters Needs you or a lead delivers. Never sent while bb's mobile push is on. |
| `notifyOnlyOrchestrator` | off | bb notifies you only for the orchestrator: cards, deliveries and the CoS thread. Every other thread is muted, except a thread you gave its own level. Turning it off restores the levels you had. Turn it off before you disable the plugin. |

**Look**

| Setting | Default | What it does |
|---|---|---|
| `ownerName` | empty | Your name, as agents and screens say it. Empty: agents say "the owner" and screens say "you". |
| `pokemon` | off | Gives each agent a Pokémon that evolves as it levels, and each project a Pokémon type whose colour is its accent. Off: neutral avatars and no accent. The screenshots here have it off. |
| `hiddenTabs` | empty | Tabs to hide from the page, comma-separated, by id or label (e.g. `gameboy, rules, activity`). Empty: every tab shows. A pane left on a hidden tab moves to the first tab shown, and the page never hides them all. |

**Provider, model and reasoning** for the agents started with the Start buttons on Projects (or by the CoS). An
explicit choice the machine's provider can't confirm is refused at start:

| Setting | Default |
|---|---|
| `cosProvider`, `cosModel`, `cosReasoning` | `claude-code`, `claude-opus-5-5`, `high` |
| `leadProvider`, `leadModel`, `leadReasoning` | `claude-code`, `claude-opus-5-5`, `high` |
| `stewardProvider`, `stewardModel`, `stewardReasoning` | `claude-code`, `claude-sonnet-5-5`, `medium` |

**Projects tab links**

| Setting | Default | What it does |
|---|---|---|
| `linearWorkspace` | empty | Your Linear workspace (the slug in `linear.app/<slug>`). Linear ids such as ABC-12 on the Projects tab then link to their issues. Empty: they stay plain text. |
| `linearTeams` | empty | The team keys that link, comma-separated. Empty: every key links. Ids of other teams, and look-alikes such as model names, stay plain text. |

**Mail between agents**

| Setting | Default | What it does |
|---|---|---|
| `batchInbox` | off | Off: each message reaches its agent on its own turn. On: each agent's unread mail is batched behind one wake. See [docs/batched-inbox.md](docs/batched-inbox.md). |
| `inboxDebounceMs` | 2000 | How long, in milliseconds, a batched wake waits for more mail. |
| `integrationRoutes` | `{}` | Opt-in imports of mail from outside tools: a JSON object of source ids to the addresses each may write to. Empty: no imports. Imported mail is never an approval. |

**Open PRs** (the first four are empty by default; the tab says what to set)

| Setting | What it does |
|---|---|
| `githubLogin` | The GitHub login whose open PRs the tab lists. |
| `reviewChannel` | Your code-review Slack channel: a name (`team-reviews`) or an https link. Post opens it; it never sends. |
| `reviewExcludedProjects` | Project slugs, separated by commas or spaces, whose PRs start unticked in Post. |
| `slackHandleMap` | A JSON object of GitHub login to Slack handle, e.g. `{"some-login": "slackname"}`. Only mapped logins are tagged. |
| `prPollMinutes` | How often PRs are checked, in minutes (default 5; 0: one first read, then no refresh). The tab checks only while it is open. |

**Retention** (both off by default: nothing is ever deleted)

| Setting | Default | What it does |
|---|---|---|
| `retentionDays` | 0 | Once a day, deletes what finished more than this many days ago: closed mail between agents, settled, moot and merged cards (and their copies in the state folder), closed PR waits, Board rows of retired agents, and old Steward alarms. Anything still open stays, whatever its age, and so does anything an open card, message, wait or deliverable points at. Agents, projects, deliverables, outputs, rules and pins are never deleted. 0: keep forever. |
| `activityRetentionDays` | 0 | The same for the activity log behind the project pages' history. Each thread's latest status and each live agent's start stay. 0: keep forever. |

`bb orchestrator prune --dry-run` lists how many rows each table would lose; `bb orchestrator prune` deletes them
now and gives the space back to the disk.

**Timing**

| Setting | Default | What it does |
|---|---|---|
| `escalateMinutes` | 5 | A question the CoS hasn't triaged reaches you after this many minutes. |
| `resendMinutes` | 10 | An unanswered message is sent again this many minutes after its recipient goes idle. |

## Keyboard shortcuts

Press **?** on the page for the full list. They work while the page has the focus and you aren't typing in a box.

| Keys | What it does |
|---|---|
| J / K | Next / previous card (Needs you, Deliverables) |
| 1 – 4, then Enter | Pick an answer on the selected card, then send it (Needs you; an agent's own question opens with O instead) |
| O | Open the selected card's asker thread (Needs you) |
| A, A | Done, nothing more on the selected deliverable: press twice within 2 seconds |
| C | Jump to the box that messages the CoS |
| Shift+N / P / D / H | Needs you / Projects / Deliverables / Chat |
| Esc | Leave a text box (your text stays), or close the shortcut list |
