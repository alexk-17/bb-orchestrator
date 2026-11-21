---
name: memory
description: "Search the memory before re-deriving a past decision or a fact about your project, and read your project's vault page. Read-only: never edit the vault."
---

# Memory

Before you re-derive a past decision or a fact about your project, search for it.

- **Search:** the `memory_search` tool, with `project` set to your project's slug (your instructions name it) to keep to
  it. Add `transcripts: true` to also search past Claude sessions. A shell has the same search:
  `memory-search "<topic>" --project <your project>`. It is keyword search (ripgrep, BM25) and takes seconds.
- **Read:** the `memory_page` tool, with your project's slug for its vault page, or a hit's `path:line`.
- **Your project's page** is `projects/<your project>.md` in the vault (your instructions give the full path). When
  there's no page by that name, a search with `project` shows the one it has, if any.
- **Never edit the vault.** Read it only: the memory publisher is its one writer.
