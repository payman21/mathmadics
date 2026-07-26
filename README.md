# MathMADics

A fast, mental-math arcade game. Two-minute rounds of multiple-choice
arithmetic that ramp in difficulty as you go, score you on speed and streaks,
and rank you against everyone else on three cloud leaderboards.

**Play it live: [www.mathmadics.com](https://www.mathmadics.com/)**

---

## Table of contents

- [What it is](#what-it-is)
- [Game modes](#game-modes)
- [The question engine](#the-question-engine)
  - [Operations and operand ranges](#operations-and-operand-ranges)
  - [Difficulty and the level ramp](#difficulty-and-the-level-ramp)
  - [Deterministic, seeded rounds](#deterministic-seeded-rounds)
  - [Multiple-choice distractors](#multiple-choice-distractors)
- [The scoring system](#the-scoring-system)
  - [Base points](#base-points)
  - [Speed bonus](#speed-bonus)
  - [Streak bonus](#streak-bonus)
  - [Penalties and passing](#penalties-and-passing)
  - [Worked example](#worked-example)
  - [Why difficulties share one board](#why-difficulties-share-one-board)
- [Stats: accuracy, answers/min, streak](#stats-accuracy-answersmin-streak)
- [The three boards](#the-three-boards)
- [Accounts and privacy](#accounts-and-privacy)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Running and deploying](#running-and-deploying)
- [Fairness and anti-cheat](#fairness-and-anti-cheat)

---

## What it is

Each ranked round is **120 seconds**. You are shown an arithmetic question with
four answer choices; tap the right one (or press keys `1`–`4`). Correct answers
earn points scaled by how hard the question was, how fast you answered, and how
long your current streak is. Wrong answers cost points and reset the streak. The
questions get harder the longer you survive in the round.

When time runs out you get a results screen with your score, a breakdown by
operation, a "your pattern" insight, a review of your misses, and — once you've
claimed a name — your placement on the global boards.

---

## Game modes

| Mode | Players | Ranked? | Notes |
|------|---------|---------|-------|
| **Solo sprint** | 1 | ✅ Yes | The only mode that counts toward the boards. 2-minute round. |
| **Practice** | 1 | ❌ No | Pick your own length; warm up freely. Nothing is saved to the boards. |
| **Head to head** | 2 | ❌ No | Both players get the **identical** question sequence (same seed), take turns, then compare. Two players can't be ranked against each other, so it's unranked. |
| **Daily challenge** | 1 | — | A seeded round that is the same for everyone on a given calendar day. |
| **Shareable challenge** | 1 | — | Any round can be encoded into a link (`?c=…`) so a friend faces the exact same questions. |

Only **solo, non-practice** rounds are ranked (`isRanked()` requires one player
and practice mode off).

---

## The question engine

### Operations and operand ranges

Four operations: **addition, subtraction, multiplication, division**. Every
question is generated for a **level** from 1 to 7, and each level defines the
operand ranges. Construction guarantees clean problems:

- **Addition / multiplication** — two operands drawn from the level's ranges (order randomly swapped).
- **Subtraction** — built as `a = b + answer`, so the result is always non-negative and grows in size and digit count with level (not just bigger operands with tiny differences).
- **Division** — built as `dividend = divisor × quotient`, so every division is **exact** (no remainders).

Representative ranges (addition shown; each operation has its own table):

| Level | Operand A | Operand B | Feel |
|------:|-----------|-----------|------|
| 1 | 2–9 | 2–9 | single digits |
| 2 | 10–49 | 3–9 | |
| 3 | 12–99 | 12–99 | two-digit |
| 4 | 25–99 | 25–99 | |
| 5 | 100–499 | 25–99 | into the hundreds |
| 6 | 100–999 | 100–999 | |
| 7 | 250–999 | 250–999 | maximum |

### Difficulty and the level ramp

The three difficulties differ in **where on the 1–7 ladder you start**:

| Difficulty | Starting level | Score multiplier |
|------------|:--------------:|:----------------:|
| Easy | 1 | ×1.0 |
| Medium | 3 | ×1.5 |
| Hard | 5 | ×2.2 |

Within a round, the level **ramps upward by question index**. Roughly every
`round(duration / 9)` questions — **13 questions** in a 120-second round — the
level goes up by one, capped at 7:

```
level = clamp(startLevel + floor(questionIndex / 13), 1, 7)
```

So an Easy round climbs 1 → 7 as you answer; a Hard round starts at 5 and reaches
max quickly. The HUD shows the current level and how many questions remain until
the next one.

### Deterministic, seeded rounds

Questions come from a seeded PRNG (`mulberry32`), not `Math.random()`. A round is
fully determined by its **seed**: the same seed always produces the same
questions, in the same order, with the same answer-choice layout. This is what
makes three features possible and fair:

- **Head-to-head** — both players replay the identical sequence.
- **Daily challenge** — everyone gets the same puzzle: `seed = hash("math-sprint-daily-" + YYYY-MM-DD)`.
- **Shareable challenges** — the seed travels in a URL, so a friend faces your exact round.

The option-building step always consumes the RNG even in modes where layout
doesn't matter, so the question stream stays byte-for-byte identical across modes.

### Multiple-choice distractors

The three wrong answers aren't random noise — they're **plausible mistakes**,
which makes the game diagnostic rather than guessable. Depending on the
operation, candidates include:

- **Addition** — the no-carry sum (`35 + 57 → 82` instead of 92), ±10 / ±20, a digit transposition of the answer.
- **Subtraction** — the no-borrow difference (`52 − 35 → 23` instead of 17), ±1 / ±10 / ±20, transposition.
- **Multiplication** — off-by-one-factor products (`(a±1)·b`, `a·(b±1)`), ±10, transposition.
- **Division** — ±1 / ±2 / ±10, transposition.

Distractors that share the answer's **digit count** are preferred, so you can't
shortcut by length. If not enough valid, plausible distractors exist, the builder
fills with operation-appropriate offsets.

---

## The scoring system

Every correct answer is scored as:

```
points = round( base × (1 + speedBonus + streakBonus) )
```

Bonuses **multiply** the reward; penalties do **not** get multiplied — a design
choice so a wrong answer hurts most exactly where your bonuses are weakest.

### Base points

Base points are tied to how long the level is *expected* to take, so a level's
reward tracks what it actually costs you:

```
base = round( 10 × parSeconds × difficultyMultiplier )
```

where `parSeconds` is the level's expected solve time. Par times: **1.5, 2.0,
2.6, 3.3, 4.3, 5.6, 7.2 s** for levels 1–7. On Easy (×1.0), that's a base of
**15** points at level 1 rising to **72** at level 7; Medium and Hard scale those
by ×1.5 and ×2.2.

### Speed bonus

Worth up to **+0.5×**, measured against the level's par (not an absolute clock),
so "fast" stays reachable even at level 7:

- Answer in **≤ 60% of par** → full **+0.5**.
- Answer in **≥ 160% of par** → **+0.0**.
- In between → linear.

### Streak bonus

Consecutive correct answers add up to **+0.5×**, capping at a streak of **5**:

```
streakBonus = 0.125 × clamp(streak − 1, 0, 4)
```

The cap keeps the streak bonus from becoming an easy-questions-only reward (long
streaks are only cheap at low levels).

**Maximum multiplier** on any single answer is therefore `1 + 0.5 + 0.5 = 2.0×`
base — fast *and* on a hot streak.

### Penalties and passing

- **Wrong answer** — `−round(base × 0.5)`, and your streak resets to 0.
- **Pass** — skip a question you don't want; costs **4 seconds** off the clock and resets the streak, but is *not* counted as a wrong answer (so it doesn't dent accuracy).

### Worked example

A level-5 Hard question (par 4.3 s, multiplier ×2.2):

```
base       = round(10 × 4.3 × 2.2) = 95
answered in 2.4 s  (< 60% of par)  → speedBonus = +0.5
current streak = 4                 → streakBonus = 0.125 × 3 = +0.375
points     = round(95 × (1 + 0.5 + 0.375)) = round(95 × 1.875) = 178
```

### Why difficulties share one board

Because harder settings both **start higher** on the ladder and **pay a bigger
multiplier**, expected score rises with difficulty at every skill level (roughly
**1.0 / 1.4 / 1.9×** in practice). That's what lets Easy, Medium, and Hard all
compete on a single leaderboard rather than being split into three.

Round **length**, by contrast, *can't* be reconciled by a multiplier — a longer
round simply yields more answers — so every ranked round is fixed at 120 seconds.

---

## Stats: accuracy, answers/min, streak

- **Accuracy** = `correct / (correct + wrong)`. Passes are excluded from the denominator.
- **Answers per minute (qpm)** = `attempted / (durationMinutes)`, where `attempted = correct + wrong`, rounded to one decimal.
- **Best streak** = the longest run of consecutive correct answers in the round.

The results screen also computes a **"your pattern"** insight (your fastest and
weakest operations, from per-operation correct/wrong/time stats) and a **miss
review** listing the questions you got wrong with the right answer.

---

## The three boards

All three are **cloud-only** (there is no local high-score list) and are derived
from a single `scores` table:

1. **Your last 10 games** — your own most recent rounds. Private to you.
2. **Top 10 scores** — the highest **single-round** scores anyone has ever posted.
3. **Global leaderboard** — every player ranked by their **total score across all rounds, all time** (plus how many games they've played).

All boards are scoped to the current **scoring version**. Scores earned under
different scoring rules aren't comparable, so a rules change (e.g. the move from
1-minute to 2-minute rounds) starts a fresh board rather than mixing eras.

---

## Accounts and privacy

- **No sign-in to start.** Every visitor is issued an anonymous account and can play immediately.
- **Claim a name to save.** Scores are saved once you claim a **username** (via Google, or a one-time email magic link — never a password). The round you just finished is held across the sign-in redirect and recorded the moment you land back.
- **Email is private.** It lives in Supabase's `auth.users` only and is never shown. The public identity is a separate **username** (a nickname; real names not required).
- **Upgrade, don't replace.** Claiming upgrades the anonymous account in place, so the identity carries forward.

---

## Tech stack

**Frontend**
- Vanilla **HTML / CSS / JavaScript** — no framework, no build step. The game core is a single self-contained script; the cloud layer is an ES module.
- **Web Audio API** for feedback sounds (synthesized, no audio assets).
- Minimal browser storage: only the auth session and a single pending round that must survive the sign-in redirect. No game data is stored locally.

**Backend**
- **Supabase** (managed **PostgreSQL**) for accounts, scores, and the boards.
- **Supabase Auth** — anonymous sign-in, Google OAuth, and email magic links.
- **Row-Level Security (RLS)** as the entire authorization model; the public anon API key authorizes nothing on its own.
- **`SECURITY DEFINER` SQL functions** serve the public boards, so raw score rows stay owner-only while the aggregated/top data is world-readable.
- `supabase-js` loaded from a CDN (esm.sh) as an ES module — no bundler.

**Hosting**
- **Cloudflare Pages** (static hosting) at **[www.mathmadics.com](https://www.mathmadics.com/)**.
- Domain registered via **Squarespace**, DNS pointed at Cloudflare.

---

## Architecture

```
Browser (mathmadics.com, Cloudflare Pages)
├─ index.html            game core: question engine, scoring, UI, modes
├─ math-sprint-v3.css    styles
├─ math-sprint-supabase.js   cloud layer (ES module)
└─ supabase-config.js    project URL + public anon key (safe to ship)
        │
        │  supabase-js over HTTPS
        ▼
Supabase (PostgreSQL + Auth)
├─ auth.users            identities & email (private)
├─ public.profiles       public usernames
├─ public.scores         every ranked round (owner-only via RLS)
└─ SECURITY DEFINER fns   get_top_scores · get_total_leaderboard · get_score_rank
```

The game core is decoupled from the cloud: it emits a `mathsprint:results`
DOM event at the end of a round, and the Supabase module listens for it. If
Supabase is unconfigured, the module disables itself and the game still runs.

## Data model

- **`profiles`** — `id` (→ `auth.users`), unique `username` (2–16 chars). The public nickname; contains no email.
- **`scores`** — one row per ranked round: `score`, `accuracy`, `qpm`, `correct`, `wrong`, `passed`, `best_streak`, `difficulty`, `duration`, `scoring` (version), `created_at`. This is the single source of truth for all three boards.
- **Board functions** (all scoped to a scoring version):
  - `get_top_scores(scoring, limit)` — highest single-round scores, joined to username.
  - `get_total_leaderboard(scoring, limit)` — `sum(score)` per player, with games played.
  - `get_score_rank(scoring, score)` — where a given round would place among all single rounds.

RLS keeps `scores` readable only by its owner; the `SECURITY DEFINER` functions
are the only path to the public, aggregated views. Full policies and functions
live in [schema.sql](schema.sql). Setup instructions are in
[SETUP-SUPABASE.md](SETUP-SUPABASE.md).

## Running and deploying

**Locally** — it's a static site, but must be served over HTTP (ES modules +
Supabase won't work from `file://`):

```bash
python3 -m http.server 8753
# then open http://localhost:8753/math-sprint-v3.html
```

**Cloud backend** — create a Supabase project, run [schema.sql](schema.sql), fill
in [supabase-config.js](supabase-config.js), and enable the auth methods
(Anonymous, Email, Google). See [SETUP-SUPABASE.md](SETUP-SUPABASE.md).

**Production** — the `dist/` folder holds only the four files the site serves
(HTML as `index.html`, CSS, the Supabase module, and config). It is deployed to
Cloudflare Pages. Sensitive files (OAuth client secrets, logs, the Firebase
prototype) are intentionally excluded from what gets published.

## Fairness and anti-cheat

Scores are computed in the browser, so a determined user could open devtools and
insert a fabricated number. RLS ensures a player can only write their **own**
rows, and the public boards are read-only functions — but nothing can tell a real
900 from a forged one. For a friendly game this is an accepted trade-off;
hardening it would mean validating whole rounds server-side.
