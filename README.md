<div align="center">

# Greenroom

**Software for independent music venues.**

This is the starter codebase for the Greenroom Applied AI PM case study.

</div>

---

You're looking at a working but mediocre product. It's enough to feel real, but every workflow has gaps. **Your job isn't to fix everything — it's to pick a slice and design it well.** See your case study brief for full instructions.

---

## Settlement: every deal type, with the math shown

The Deal Builder captures the deal. Settlement is where it gets paid, and where
trust breaks. The old in-app settlement tool (`lib/dealMath.ts`) handled only
flat and %-of-gross deals; everything else fell back to a spreadsheet.
`/shows/[id]/settle` now settles **all five deal types** with the new engine.

### What it does

| Capability | Where |
|---|---|
| Settles flat, %-of-gross, %-of-net, vs (net and gross basis) and door deals, including ratchets, walkouts, sellout/attendance/gross-threshold bonuses, comps that count toward gross, recoups and prior advances | `lib/settlementEngine.ts` |
| Every line traces to its sources: ticket reports, each receipt, comps, recoups, the deal clause. Tap a line to see them | `components/settlement/SettlementWorksheet.tsx` |
| **Terms that can be read two ways are never decided silently.** The engine returns both readings and what each pays (recoup inside vs on top of the cap, disputed recoups, door fees, ratchet scope, walkout amount, notes-vs-field percentage). The booker and tour manager pick one in the room | `settleWithDecisions()` |
| Recoups already inside the receipts are not charged twice; expenses over the cap are shown as covered by the venue | engine |
| Checks before signing: duplicate receipts, hospitality over the rider, comp notes that contradict their flag, notes that say a term changed, deal-type mismatch | `runChecks()` |
| **Record of the room**: decisions, what was questioned, what was agreed, who signed. Saved as a snapshot in `data/settlementRecords/` | `lib/settlementRecordStore.ts` |
| **Drake's view** (the tour manager): phone-first, read-only, plain-English summary + every line with sources + what was agreed | `/shows/[id]/settle/share` |

The math is deterministic on purpose: both sides must be able to reproduce it.
The plain-English summary is a deterministic template today; the decision
detection is rules-based. Both are shaped so a language model can later read
the deal email and draft the summary, with the arithmetic staying in code.

**Try this path:** open `/shows/show_coastal_spell_dispute/settle` (the WME
marketing-recoup dispute). The engine shows that documented receipts were
$1,600, so the $900 recoup plus receipts lands exactly on the $2,500 cap: both
readings of the ambiguous clause pay **$12,285**, the amount that was finally
agreed after a three-day email dispute. Pick how to treat the disputed recoup,
add what was questioned and agreed, save, then open **Drake's view**.
Door deals (e.g. `show_0018`) show the fees decision; `show_0014` has a ratchet.

### Replay test against every past settlement

```bash
npm run replay   # writes data/replay-report.md
```

Runs all 498 past settled shows through the engine and compares with what was
actually paid. Result: **82% match exactly as written; 18% differ and every one
is explained by how the venue used to settle** (for example vs-gross deals
settled on net, agreed recoups never charged, comps that should count toward
gross left out), with the dollars attributed to each practice. One show needs
human review. The old engine could settle 38% of these shows at all.

---

## Backstage, the Deal Ledger agent

Backstage is an agent that takes a show from the offer email to a settlement ready to sign,
and stops before money moves. Open `/shows/show_coastal_spell_dispute/agent`
(or any show → **Send to Backstage**), and `/agent` for routing, autonomy and the
eval scorecard.

| | |
|---|---|
| **Live progress** | Press **Send to Backstage** and watch each step as it happens: which step is running, which model is working on it (and any escalation or fallback), how long each call took and what it cost, and where Backstage stops for a person. The page streams the run from `app/shows/[id]/agent/run/route.ts`; `npm run agent` prints the same progress in the terminal |
| **What it does alone** | Reads and sorts the email, extracts the deal terms (every money term must quote the email, and code checks the quote), flags terms that can be read two ways, calculates the settlement with the engine, prepares the packet and Drake's summary (every number checked against the engine), answers questions at the table |
| **What it asks about** | Commits terms only if every check passes; otherwise Ethan confirms. Messages to Drake (the artist's side) are drafts; Ethan sends them |
| **What it can't do** | Approve a settlement, release a payout or send email. Those tools don't exist on the agent's side (`lib/agent/tools.ts`), so no prompt can make it move money |
| **Models** | One gateway (`lib/agent/router.ts`) and a routing table (`lib/agent/routing.ts`): local Gemma 4 12B, Claude Haiku / Sonnet / Opus 5.5, GPT-6 Luna / GPT-6.1 Sol, or rules. Escalates when a check fails, falls back when a model is down, logs tokens, latency and cost per call |
| **Flag checks** | Every two-readings flag, from any model, must pass code checks before it counts (`lib/agent/tasks/flagChecks.ts`): the quote is in the email, the two readings differ, the sentence is about pay, the clause that kind of ambiguity needs is there (a recoup question needs a cap and something taken back; a ratchet needs two rates), and the email doesn't already settle it |
| **Evals** | `npm run eval` runs the same test sets against any models: extraction on the real deal notes and on paraphrases, two-readings detection (what the model flagged and what survived the checks, plus a set in new wording), and the 24 disputed settlements. `--suite readings` re-runs only the two-readings sets and keeps the extraction scores from the last run |

The engine prices every flag. On Coastal Spell, the agent flags "expenses capped
at $2,500, marketing recoup of $900 against gross" at booking. The engine shows
both readings pay $12,285 at that show's actual receipts, but $11,565 vs $12,285
if receipts had reached the cap: the $720 the venue later conceded.

```bash
npm run agent:test        # self-test with mock models: routing, fallback, escalation, guardrails
npm run agent -- --show show_coastal_spell_dispute --profile local
npm run eval -- --models rules,gemma-local,haiku-5.5,sonnet-5.5
npm run eval -- --models rules,gemma-local --suite readings   # only the two-readings sets
npm run models:check -- --models haiku-5.5,sonnet-5.5         # one tiny call each: key, model name, credits
npm run eval -- --models haiku-5.5 --n 10                      # Haiku on every suite
npm run eval -- --models sonnet-5.5 --suite readings           # Sonnet only on the reasoning step
```

Each run adds its models to the same scorecard, so the Haiku, Sonnet, Gemma and rules rows sit side by side.
Rate limits and overloads (429/529) are retried with backoff; a bad key or an empty balance fails at once
and the eval prints the API's message.

`data/eval/latest.json` and `report.md` are committed so the scorecard on `/agent`
shows the last real run. `report.md` lists every false flag and every real flag
the checks dropped.

**Run it on a local model (free, private, works offline):** install
[Ollama](https://ollama.com), `ollama pull gemma4:12b`, keep Ollama running, and
pick **Local only** on the agent page. LM Studio works too: set
`LOCAL_BASE_URL=http://localhost:1234/v1` and `LOCAL_MODEL` to the model id it
shows. Cloud models need `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `.env.local`
(see `.env.example`). With nothing configured, the agent runs on rules.

---

## The slice: Deal Builder (this prototype)

> Removed from the app on the `feat/settlement-agent` branch. The code lives on the `feat/deal-builder` branch.

This fork ships a working prototype of a **Deal Builder** — a booking-time
surface that replaces "Ethan types a deal sheet" with "Ethan approves a
recommended deal sheet," with the math derived from the venue's own data and
the rationale visible to both sides.

### Where to look

| Route | What it is |
|---|---|
| `/shows/[id]` | Existing show page, with a new **"Open Deal Builder"** button next to "Settle show" |
| `/shows/[id]/deal-builder` | The new surface. Recommendations + provenance + bonus engine + freetext reconciliation |
| `/shows/[id]/deal-builder/preview` | The agent-facing deal sheet, with the same numbers and rationale |

**Try this path:**
1. Open any past show (e.g. from `/shows`).
2. Click **Open Deal Builder**.
3. Try editing the **Expense cap** outside the recommended band — the override modal pops with `public/internal` toggle (FR-M-10, BR-09).
4. Toggle **Walkout pot** on a low-projected-gross show — it's hard-blocked per BR-05c.
5. Try a `door` deal — basis is locked to `net` per BR-04.
6. Open the freetext field — if the deal has a contradiction (try `show_0207`), it's flagged before save.
7. Click **Save & open deal sheet** to see the agent-facing preview at `/shows/[id]/deal-builder/preview`.

The saved deal rationale lands in `data/dealRationales/` as a JSON snapshot
(in production it'd be a column on `deals`).

### How this maps to the case study rubric

| Rubric principle | Evidence in this fork |
|---|---|
| **1. Scope tightly. Defend the cut.** | New routes are only `/deal-builder` and `/deal-builder/preview`. Settlement (`/settle`) was rebuilt afterwards on the same principles — see the section above. The PRD's BRs and non-goals are visible 1:1 in the code (search for `BR-01`…`BR-11` in `lib/`). |
| **2. Take it deep.** | All **5 deal types** (`flat`, `vs`, `percentage_of_net`, `percentage_of_gross`, `door`) get type-specific recommendations. All **4 bonus structures** (`net_threshold`, `attendance_threshold`, `sellout`, `tier_ratchet`) net-trigger by construction. Repeat-vs-new-artist branches in the recommender. T-7 cancellation flag. Freetext-vs-structured reconciliation. Override+provenance loop end-to-end. |
| **3. Show your reasoning.** | Every recommended term has a **"Why this?"** affordance showing source data + confidence. Overrides require a reason that propagates to the saved rationale. The agent-facing preview renders the *same* rationale block Ethan saw — same numbers, same provenance, both sides on one source of truth. |
| **4. Design for humans, not screens.** | Single hero number (projected venue earnings, BR-02). Phone-first layout (sticky action bar, full-width modals on narrow). Form is **never empty** — recommendations pre-fill on load. Errors render above the field, not as toasts (UX-04). Provenance is one tap, not two. |
| **5. Use AI like a senior teammate.** | **Deliberate restraint.** Deal math is deterministic — must be reproducible/defensible to agents. The single AI surface is **freetext-vs-structured contradiction detection** (`lib/freetextReconciliation.ts`) where prose drift is the actual failure mode. V1 ships with a regex implementation so the hiring team can run without an API key; the `detect()` interface is shaped for a drop-in LLM upgrade. Provenance throughout the UX is the explainability layer. |

### Architectural notes

```
lib/
  artistHistory.ts         # Artist + deal-type aggregates (p25/p50/p75) with source-show IDs
  dealRecommender.ts       # BR-driven recommendations per deal type
  dealMathV2.ts            # Canonical net-first computation (BR-01) — used by both Ethan's and Drake's views
  freetextReconciliation.ts # Contradiction detector (regex v1; LLM-ready interface)
  projection.ts            # T-7 sales projection for the cancellation flag (BR-07)
  dealRationaleStore.ts    # Persists rationale snapshots to data/dealRationales/
components/deal-builder/
  DealBuilderForm.tsx      # The main client surface
app/shows/[id]/deal-builder/
  page.tsx                 # Server entry — prepares recommendations, renders form
  preview/page.tsx         # Agent-facing preview, reads the saved rationale
  actions.ts               # Server action: save → write rationale → redirect to preview
```

### What's intentionally cut from this prototype

- **GM dashboard** — would surface overrides and approval queue. Out of slice.
- **Real PDF generation** — preview is HTML; visually equivalent for review.
- **Live ticket-pull integration** — `projection.ts` uses a naive multiplier.
- **Multi-venue** — single venue (The Crescent).

See the case study memo for the full PRD: business requirements (BR-01..BR-11),
functional requirements per persona (FR-M, FR-A, FR-G, FR-P, FR-X), trade-offs,
quantified impact (~$135K addressable / ~$67K conservative on this venue's
505-show dataset), and what ships next.

---

## Before you start

You'll need:

1. **Node.js, version 20 or higher** — get it from [nodejs.org](https://nodejs.org/) (pick the LTS version). Verify with `node -v`.
2. **Git** — most computers have it. Verify with `git --version`. If not, install from [git-scm.com](https://git-scm.com/).
3. **A code editor.** [VS Code](https://code.visualstudio.com/) is great. [Cursor](https://cursor.com/) is what we'd reach for if we were doing this case study.
4. **A GitHub account.** Free at [github.com](https://github.com/).

If you're on Windows, run all the commands below in **Git Bash**, **PowerShell**, or **WSL** — not the legacy Command Prompt.

## Setup, step by step

### 1. Fork this repo to your own GitHub account

Click the **Fork** button at the top right of [https://github.com/samay-cbh/greenroom-starter](https://github.com/samay-cbh/greenroom-starter). You'll get a copy under your own username.

> _Why fork?_ A fork is your own copy of the repo. You'll commit your changes there, and submit your fork's URL when you're done. We can see your commit history that way.

### 2. Clone your fork to your computer

```bash
git clone https://github.com/YOUR-USERNAME/greenroom-starter
cd greenroom-starter
```

(Replace `YOUR-USERNAME` with your actual GitHub username.)

### 3. Install dependencies

```bash
npm install
```

This pulls down all the JavaScript packages the project needs. Takes about 60 seconds. You may see a few warnings — those are normal and safe to ignore.

### 4. Start the app

```bash
npm run dev
```

You'll see something like:

```
▲ Next.js 16.x
- Local:   http://localhost:3000

✓ Ready in 1.2s
```

### 5. Open it in your browser

Go to **[http://localhost:3000](http://localhost:3000)**.

You'll land on Ethan's home view at The Crescent. **Click "Where to start" in the sidebar** for an in-product orientation.

> **Tip:** Press **⌘K** (Mac) or **Ctrl+K** (Windows/Linux) anywhere in the app to open the command palette — search across shows and artists instantly.

---

## What's running

You're logged in automatically as **Ethan**, lead booker at The Crescent (650-cap, Nashville). The product has these surfaces:

| Route | What it is |
|---|---|
| `/shows` | Ethan's home view. 24 months of completed shows, searchable and grouped by month. |
| `/shows/[id]` | Show detail. Deal terms, artist info, ticket sales, expenses, comps. |
| `/shows/[id]/settle` | The in-app settlement worksheet. **Try it on a few shows.** |
| `/artists` | Roster of artists who've played the venue, bucketed by frequency. |
| `/reports` | Aggregate metrics. The numbers Pri (the CEO) is watching. |
| `/context` | Orientation for you, the candidate. Linked from the sidebar. |

### Recommended path your first time through

1. Open `/context` (the sidebar's "Where to start" link). 5-minute tour.
2. Then `/shows`. Pick a Vs-deal show. Click **Settle**. See what's broken.
3. Pick a Flat-deal show. Click **Settle**. See what works.
4. Read `data/transcripts/*.md` and `data/ceo-memo.md`.
5. Look at `data/dispute-thread.md`. Then press **⌘K** and search "Coastal Spell" to find the matching show.

---

## How the data is shaped

Twenty-four months of synthetic operational data, designed to feel like a real venue:

| Table | Approx rows | What it represents |
|---|---|---|
| `shows` | ~540 | 24 months of shows. The app displays only past shows (more appear as days pass). |
| `artists` | 59 | Mix of recurring (A-tier, 4+ shows) and one-off (D-tier) acts |
| `agents` | 14 | Across WME, CAA, Wasserman, Paradigm, and independents |
| `deals` | ~540 | One per show. Mix is flat ~33%, vs ~33%, % of net ~24%, door ~5%, % of gross ~4% |
| `ticket_sales` | ~540 | One summary row per show, with realistic sell-through distributions |
| `comps` | ~1,900 | Comp tickets across 6 categories |
| `expenses` | ~2,900 | Sound, lights, hospitality, marketing, production, backline |
| `settlements` | ~540 | All shows have settlement data. Past shows display it; future shows hold it until their date arrives. |

A few things worth knowing:

**The deal `notes_freetext` field is the truth.** The structured fields (`guarantee_amount`, `percentage`, `bonuses_json`, `expense_cap`) are filled inconsistently. Ethan enters deals as prose because the structured fields don't model the actual deals well. This mismatch is part of the realism.

**Vs deals come in flavors.** About a third of Vs deals are "standard." The rest mix in walkout pots, tier ratchets, and vs-gross variants. The current in-app tool can't settle most of these.

**Settlements have a lifecycle.** The state machine runs draft → submitted → in_review → signed (or disputed) → revised → finalized → paid → voided.

**Recoups are categorized.** Settlement records carry a `recoups_json` field with line items in categories like `marketing`, `hospitality_overage`, `production_overage`. Each can be `agreed`, `disputed`, or `withdrawn`.

---

## A note before you start

Real venue data is messy. Fields drift over time. Prose contradicts structured values. Statuses don't always match the underlying reality. Patterns hide across many shows that look unremarkable in isolation. **What the UI shows you isn't always what the data says — and neither is necessarily what actually happened.**

We'd encourage you to read the data closely, query `data/greenroom.db` directly, and bring skepticism to anything that seems clean. The candidates we hire are the ones who notice that the surface-level view is incomplete.

---

## Where to look for context

```
data/
├── ceo-memo.md            # Pri's Q4 memo: "winning on completeness, losing on craft"
├── dispute-thread.md      # The March 2025 marketing-recoup dispute, in full
├── greenroom.db           # SQLite database — pre-seeded, ready to go
└── transcripts/
    ├── mariana.md         # 30-min interview with the booker
    ├── diego.md           # Tour manager perspective
    ├── marcus.md          # GM perspective
    └── sarah-kim.md       # Agent perspective (WME)
```

These aren't decorative. They contain signals the database deliberately doesn't capture — the booker's frustrations, the agent's pet peeves, the things that escalate disputes. Mine them.

---

## File map

```
app/
  context/                  # Candidate orientation page
  shows/                    # Show list with search + month grouping
  shows/[id]/               # Show detail (concert poster-style header)
  shows/[id]/settle/        # The settlement worksheet (hero number layout)
  artists/                  # Artist roster (card grid with genre dots)
  reports/                  # Aggregate metrics + craft gap analysis
  icon.svg                  # Brand favicon
  opengraph-image.tsx       # Social share image
components/
  brand/logo.tsx            # The Greenroom frequency-mark logomark / wordmark
  command-palette/          # ⌘K global search (shows + artists)
  ui/                       # Buttons, badges, cards
  layout/
    sidebar.tsx             # Fixed sidebar with active nav state
    nav-links.tsx           # Client component for pathname-aware nav
lib/
  dealMath.ts               # The settlement engine (deliberately incomplete)
  queries.ts                # Server-side data fetching (past shows only)
  format.ts                 # Money + date helpers
db/
  schema.ts                 # All tables, commented
  seed.ts                   # The 24-month synthetic seed
  index.ts                  # libsql + Drizzle client
data/                       # Markdown context + greenroom.db
```

---

## Tech stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS 4** with shadcn-style component primitives
- **Drizzle ORM** + **libsql** (pure-JS SQLite — no native compile, no setup)
- **Fraunces** (variable serif, via `next/font/google`) for display headings
- **Geist Sans / Mono** (self-hosted via the `geist` package) for body + code
- **lucide-react** for icons, **date-fns** for dates

Everything is deliberately conventional. Use Cursor, Claude Code, or any other AI tool to navigate and modify the codebase — we expect you to.

---

## How to submit

When you're done:

1. **Push your branch.** `git add . && git commit -m "your message" && git push`
2. **Send the hiring contact:**
   - The link to your forked repo
   - Your 3–5 page PRD-quality memo (PDF, Notion, or Google Doc)
   - A 5–10 minute Loom walking us through the prototype and memo together

---

## Troubleshooting

### "Command not found: npm" or "node is not recognized"

Node.js isn't installed (or isn't on your PATH). Install from [nodejs.org](https://nodejs.org/), then restart your terminal.

### "Port 3000 is already in use"

Something else is using port 3000. Two options:

**Stop the other thing first.**
- Mac/Linux: `lsof -ti:3000 | xargs kill -9`
- Windows: `netstat -ano | findstr :3000` then `taskkill /PID <pid> /F`

**Or run on a different port:**
```bash
npm run dev -- -p 3001
```

### "Module not found" or weird build errors

Your `node_modules` is probably corrupt or incomplete. Reset it:

```bash
rm -rf node_modules package-lock.json
npm install
```

### The database looks empty, or you broke the data while exploring

Reset the database:

```bash
npm run db:reset
```

This drops the SQLite file and regenerates 24 months of data. Takes ~5 seconds. Deterministic — same data every time.

### Page looks ugly or buttons aren't visible

Hard-refresh your browser to clear the CSS cache:
- Mac: **⌘ + Shift + R**
- Windows/Linux: **Ctrl + Shift + R**

### "I want to see what's actually in the database"

```bash
npm run db:studio
```

Opens [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) at `local.drizzle.studio` — a visual table browser. You can also open `data/greenroom.db` with any SQLite client (e.g. [TablePlus](https://tableplus.com/), [DBeaver](https://dbeaver.io/), or `sqlite3` CLI).

### Anything else

If you're stuck, email the hiring contact. We'd rather you ask than burn an hour fighting a setup issue.

---

Welcome to The Crescent.
