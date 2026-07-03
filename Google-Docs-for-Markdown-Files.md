# 📝 Google Docs for Markdown Files

**Date:** June 8, 2026

**Source:** Mark My Words — 👤 @jxnlco's spec for a proper markdown editor

---

## ❓ Problem

Markdown won by accident. It started as a way to write a README without learning HTML, and somewhere along the line it became the default container for human knowledge. Engineering docs, product specs, internal wikis, meeting notes. Around 1.5 million people now keep their entire second brain as plain .md files in tools like Obsidian. The format is plain text, portable, version-controllable and future-proof, which is exactly why it ate everything.

Then AI agents showed up and made markdown load-bearing. The AGENTS.md standard, the single file that tells a coding agent how your project works, is now stewarded by the Linux Foundation's Agentic AI Foundation and sits in over 60,000 repositories, read natively by Cursor, Codex, Copilot, Gemini CLI and more. Claude Code has its own CLAUDE.md. These files are not documentation any more, they are the instruction set your agents boot from. They are also the files engineers and PMs most need to keep current together.

Here is the kicker. The second two people need to work on the same .md file, the tooling falls off a cliff. Google Docs has collaboration completely solved, comments, suggestions, live cursors, full history, for over a billion monthly Docs users, but it treats markdown like a foreign language and mangles it on paste. The markdown-native crowd routes every edit through a GitHub pull request, which is a hard no for the writer, the PM or the founder who does not live in a terminal. So teams copy-paste between Docs and their repo like it is 2010, and the file that is supposed to be the single source of truth quietly drifts out of date.

## ✅ Solution

Google Docs, except it reads and writes plain .md files natively, so the thing you collaborate on is the actual file in your repo, not a lossy copy of it.

**The canonical file stays canonical.** You are not importing into a hosted format and exporting later. The document on screen is the .md on disk, so there is no round-trip and nothing to mangle. Clean preview and raw source are a toggle, not two different products.

**Real-time multiplayer, the bits Docs got right.** Live cursors, comments that sync and resolve, a suggestion mode for tracked changes, and full edit history, all on a file that stays portable markdown the whole time.

**A two-way CLI keeps it honest.** Run `open path/to/CLAUDE.md` from your terminal, edit it in the browser with non-technical teammates, and the changes land straight back in your file system and git with no copy-paste tax. The engineer never leaves their workflow, the PM never sees a pull request.

**Agents are first-class users, not an afterthought.** The same file your team is editing is the file your agents read and write all day, so human edits and agent edits meet in one place instead of two.

The wedge is deliberately narrow: own the one painful shared file, then expand outward into every doc around it.

## 📊 Key Numbers

**Market size**

The global productivity software market was worth roughly $77-81 billion in 2024 and is forecast to grow at about 14% a year to $190-265 billion by 2032. Document collaboration is the centre of that market, not a niche of it.

Google Workspace alone reports over 3 billion users and more than 13 million paying customers. Around a billion of them touch Google Docs every month. The habit of collaborating on documents in a browser is already universal.

The beachhead is smaller and sharper: 60,000+ repos with an AGENTS.md, plus every team on Cursor or Claude Code carrying a CLAUDE.md, plus the ~1.5 million markdown-native note-takers. This is a technical, high-intent, fast-growing wedge sitting inside a giant generic market.

**ARR potential**

Bottom-up: this is a per-seat collaboration tool, so price it like one at ~$8-12 per editor per month. 50,000 teams averaging 5 paid seats at $10 is 250,000 seats, or ~$30M in subscription ARR. That is a small fraction of the agent-coding install base, not a heroic share.

Layer up: the same teams have non-technical collaborators (PMs, writers, founders) who also need a seat. If the product expands from the one context file to all the docs around it, seats per team climbs and the 250,000 figure is conservative.

Realistic path to $10-30M ARR within a few years as a focused docs-as-code collaboration tool, with a $100M+ ceiling if it becomes the default editing surface for AI context files across the industry.

## ⏰ Why Now

**Markdown just became business-critical infrastructure.** For a decade markdown mattered to developers and note-takers. Now it briefs the agents that write a growing share of production code. A stale CLAUDE.md is no longer untidy, it actively degrades agent output, which gives the shared file real commercial urgency for the first time.

**The agent file is a new, contested object with no incumbent.** AGENTS.md only formalised in August 2025. There is no Google Docs of agent context files yet, because the category did not exist 18 months ago. That is a rare open lane.

**Real-time collaborative editing is finally a solved engineering problem.** CRDT and operational-transform libraries that used to be a multi-year build are now off-the-shelf. The hard part of "multiplayer Google Docs" is no longer the hard part.

**The market is already reaching for this.** Tools like the recent git-native collaborative markdown editor on Show HN, built to plug into Claude as persistent memory, show the exact itch is being scratched in public. When indie builders converge on a problem, the timing is right and the clock is running.

## 💼 Business Model

Per-seat SaaS, the proven model for collaborative document tools:

- **Free tier:** solo use and public files, to seed bottom-up adoption inside engineering teams the way the best dev tools always have.
- **Team plan:** ~$8-12 per editor per month for private files, suggestion mode, comment threads, history and the git/filesystem sync. This is the core revenue line.
- **Usage on top:** larger history retention, more private repos connected, SSO and audit logs as the enterprise upsell.
- **Enterprise:** self-hosting and on-prem for security-conscious orgs that will not put their context files in someone else's cloud, priced per seat with a floor.

The model aligns with the wedge: land a couple of engineers editing one file for free, convert the team when the PM and the writer need seats too, expand to the rest of the docs.

## 🥊 Competition

Be honest, this lane is not empty. The good news is that nobody has nailed the specific promise.

**HackMD.** The closest competitor by far, and it literally bills itself as "Google Docs for Markdown" with a million-strong community, real-time editing, comments, history and GitHub sync. It is already moving on the agent angle, pitching itself as the shared context layer for teams and their agents. The gap to exploit: HackMD still hosts the canonical document and syncs out to GitHub, so the file in your repo is a copy of the source of truth, not the source of truth. The pitch here is the inverse, the file on disk stays canonical and the editor is just a window onto it.

**Google Docs.** Owns collaboration and a billion users, but is structurally hostile to markdown and has zero incentive to make the repo file the canonical object. Its strength is exactly what stops it serving this user.

**Notion.** A $11 billion, 100M-user juggernaut now built around AI agents, but it locks you into blocks, not portable .md files. Great if you want a workspace, useless if you need the actual file to live in git.

**GitBook and Outline.** Strong on docs-as-a-published-site and internal wikis with markdown underneath, but built for publishing and knowledge bases, not for low-friction collaborative editing of a single repo file with a non-technical teammate.

**Pull-request workflows (GitHub, the status quo).** The default that this product replaces. Fine for engineers, a wall for everyone else.

The opening: take real-time collaboration that already exists, point it at the actual file in the repo rather than a hosted copy, and win the file the others either mangle (Docs), wrap (Notion) or treat as a sync target rather than the source (HackMD).

## 🚀 Go-to-Market

**Win one file: CLAUDE.md.** Do not launch "a markdown editor". Launch the fastest way for an engineer and a PM to co-edit their agent context file without a pull request. One painful file, owned completely.

**Distribute where the agent crowd lives.** Cursor and Claude Code communities, the AGENTS.md ecosystem, Hacker News, dev-tool newsletters. The open CLI command is the viral hook, it is the kind of thing engineers screenshot and share.

**Lead with the copy-paste tax.** The shareable story is "we stopped copy-pasting our specs between Docs and the repo." Every technical team feels that pain weekly.

**Land bottom-up, expand to the non-technical seats.** Engineers adopt it free for the context file, then pull in the PM, the writer and the founder who could never touch the repo before. That second cohort is where the seat count and the revenue actually come from.

**Own the content lane.** "How to let your whole team edit CLAUDE.md without a pull request" is a high-intent, low-competition search today. Own it with guides and templates before anyone else does.

## ⚠️ Risks

**The obvious wedge is already contested.** HackMD and at least one indie git-native editor are openly chasing the agent-context-file story right now. The differentiator (canonical file on disk, not a hosted copy) is real but thin, and has to be felt immediately or it reads as a feature, not a product. This is the risk to validate against first.

**True two-way sync is deceptively hard.** Reconciling live multiplayer edits in the browser with local edits, git commits and an agent writing to the same file is a genuine merge-conflict and data-integrity problem. Getting it almost right is worse than not shipping it, because it will silently corrupt the one file teams trust most.

**Markdown is not one spec.** Tables, footnotes, frontmatter, callouts and the various flavours (CommonMark, GFM, MDX) all differ. "Reads and writes plain markdown natively" is easy to say and a long tail to actually honour without mangling anyone's file.

**A big player could absorb it.** If GitHub, Cursor or Anthropic decided collaborative context-file editing should be native, the wedge narrows fast. Speed and a loved product are the only moat early.

**The non-technical seat is the whole thesis, and unproven.** The model only works if PMs, writers and founders genuinely adopt it. If it stays an engineer tool, it is a smaller business competing directly with HackMD on its home turf.

## 📝 Summary

Markdown quietly became the default container for human and machine knowledge, and AI agents just made the most important markdown files, the context files they boot from, into something a whole team needs to keep current together. The collaboration layer for those files does not exist in the right shape. Google Docs mangles markdown, Notion wraps it, pull requests gate it, and even HackMD treats the repo file as a sync target rather than the source of truth. The unclaimed promise is simple: real-time collaboration where the file in your repo stays canonical and the browser is just a window onto it.

It sits inside an ~$80 billion productivity market growing double digits, rides a clean timing unlock (agent context files went from non-existent to 60,000+ repos in under two years), and has a sharp, high-intent wedge in CLAUDE.md and AGENTS.md. The honest catch is that the wedge is already being chased and the core engineering (trustworthy two-way sync) is the hard part, not the editor.

Best of all, it is cheap to find out. Build the narrowest possible version, two people co-editing one CLAUDE.md with the open CLI and changes landing back in git, and put it in front of fifty Cursor and Claude Code teams. If they stop copy-pasting and start inviting their PMs, you have a product. After that it is a numbers game.

---

*Source: <https://loud-particle-7d0.notion.site/Google-Docs-for-Markdown-Files-3788d2b9402b80e6bac2fae9be897e3d>*
