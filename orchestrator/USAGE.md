# How it works

The Orchestrator page in bb, on one page. To install the plugin, see its README.

## Who does what

| Who | What it does |
|---|---|
| **You** | Answer cards, review deliverables, set the direction. You act only through this page. |
| **Chief of Staff** (CoS) | Triages every question before it reaches you: settles it from a standing rule, merges a duplicate, sends it back, or puts it to you as a card. Starts projects and their leads. |
| **Lead** | One per project. Plans it, starts threads from a plan you approved, and delivers finished work to you. |
| **Thread** | Does one piece of work and reports to its lead. |
| **Steward** | Watches the machine (disk, memory, CPU) and runs a few allow-listed cleanups. |

## How work moves

- **Questions go up as cards.** A thread asks its lead; the lead settles it or forwards it to the CoS; the CoS settles
  it or puts it to you with 2 to 4 options. Your answer goes back to the agent that asked.
- **Finished work comes to you as a deliverable**, with its proof (screenshots, checks, a PR). Approve it, or request
  changes and the lead revises it.
- **You can write to a lead** from its project, or reply under any post on Home. The CoS gets a copy.

## Start here

1. **Start the CoS:** an empty Home shows **Start here**; press **Start** on its first step.
2. **Tell it what to build** in **Chat**. It creates the project and starts its lead.
3. **Cards and deliverables then land on Home.**

## The page

Four places: **Home**, **Chat**, **Projects** and **Reviews**. On a wide window they are the column on the left, with
**Tools** at its foot; on a phone they are the bar at the bottom, with Tools behind ⚙ at the top. "Open beside" on a
place puts it in a second pane. A pane's Split right or Split down opens an empty pane with a list of the views to
pick from (Esc cancels it); the view button at the left of a pane's header changes what that pane shows.

- **Home** is where the page opens: one stream of what your agents ask, deliver and report.
  - **All**: everything. Answer a card or approve a deliverable right in it, or open a post to see its conversation.
  - **Needs you**: the open cards, then what waits on an agent, what the CoS is triaging, and what you deferred.
  - **Delivered**: what waits for your review, then the past ones and their files, with a project filter and search.
  - **Alerts**: what the Steward and the hosts report.
- **Chat**: the CoS's own chat.
- **Projects**: each project's lead chat, goal, what needs you, what blocks it, its threads, PRs and record. Its page
  shows the Timeline, the Flow and the Dependencies on one scroll.
  - **Scope**: projects and tasks being scoped with their lead. It shows only while something waits there.
  - **Pathways**: a project's dependency and what's-next map, built locally from its plan, threads, PRs and cards (or from Linear once `linearApiKey` and `linearProjectId` are set). Tickets that need a decision offer **Guide me** for on-demand, advice-only route tradeoffs that can prefill the decision draft.
- **Reviews**: your open PRs and the review ask to paste (once `githubLogin` is set), then your team boards and the
  CodeRabbit queue once each is in use. A board's card opens it.
- **Tools**: **Rules** (standing answers), **Activity** (mail, dead letters, agents, decisions) and this page.

### Hidden until used

- **Team boards** (Multiplayer) show in Reviews once a board exists.
- **The CodeRabbit queue** shows in Reviews once it is set up: the schedule on, a PR queued, a run, or
  `reviewQueueDryRun` off. Dry-run is on by default, so nothing is posted until you decide.
- **Game Boy** and **Cloud** are off until you turn on **Tools: Game Boy** or **Tools: Cloud** in the settings.
- Each still opens from its link. To add a first board or set CodeRabbit up, open **Tools** and pick **Set up
  Multiplayer** or **Set up CodeRabbit**.

## Keyboard shortcuts

Press **?** on the page for the full list.

| Keys | What it does |
|---|---|
| J / K | Next / previous card (Home's Needs you and Delivered) |
| 1 – 4, then Enter | Pick an answer on the selected card, then send it (Needs you) |
| A, A | Approve the selected deliverable: press twice within 2 seconds |
| Shift+N / P / D / H | Needs you / Projects / Delivered / Chat |
| [ / ] | Previous / next pane |
| \ / - | Split the pane right / down, then pick its view |
| Esc | Leave a text box (your text stays), or close the list |

## Settings that matter

| Setting | Default | What it does |
|---|---|---|
| `ownerName` | empty | Your name, as agents say it. Empty: "the owner". |
| `pushNeedsYou` | on | A desktop or web push when a card enters Needs you. |
| `hiddenTabs` | empty | Tabs to hide, by id or label, comma-separated. |
| `showGameBoy`, `showCloud` | off | Turn on Game Boy or Cloud (Tools). |
| `linearApiKey`, `linearWorkspace` | empty | Optional Linear maps in Pathways, and Linear ids that link. |
| `guideProvider`, `guideModel` | `claude-code`, `claude-opus-5-5` | Provider and model for the on-demand Pathways Guide advisor. |
| `githubLogin`, `reviewChannel` | empty | Open PRs and its review ask. |
| `reviewQueueDryRun` | on | CodeRabbit's queue shows what it would post, and posts nothing. |
| `pokemon` | off | A Pokémon per agent that evolves as it levels. |
