# AEO experiment — does proof change the answer?

Letterprove rests on one empirical claim:

> AI agents are more diligent than humans. When evaluating 30 products, they're
> swayed by proof.

That is testable, and it is cheaper to test now than to assume and find out
after the collector is built. This directory tests it.

## The design

The same buying decision is put to the model twice. The only thing that differs
is the target vendor's evidence:

| Arm | The target vendor offers |
|---|---|
| `proof` | A link to signed, machine-readable attestations at `/proofs/vantage` |
| `control` | A testimonial quote of comparable length |

Both arms give the target the same number of extra words, so the experiment
measures *verifiability* rather than *entry length*. Every other candidate is
identical across arms. The model gets `web_search` and `web_fetch` and can
check anything it likes.

## What is measured

**The primary signal is behavioural, not self-reported.** Asking a model whether
proof influenced it produces a plausible sentence with no evidential value. So
the runner reads what the model *did* off the API response:

- `fetched_proof` — did it actually issue a `web_fetch` against the proof
  endpoint? This is a fact about what happened.
- `web_fetches` / `web_searches` — how much checking it did at all.
- `target_rank`, `recommended_target`, `confidence` — the decision it reached.

A live deployment gives the same fact from the other side: the proof endpoints
log every fetch and classify the requester (`src/lib/access/`), so
`[letterprove:access]` lines in the platform log confirm the fetch independently
of anything the model says about itself.

## Running it

```bash
npm install
node experiments/aeo/run.mjs --base https://<your-deploy> --rounds 3
```

Requires `ANTHROPIC_API_KEY` (or an `ant auth login` profile).

> [!IMPORTANT]
> **`--base` must be publicly reachable.** `web_fetch` runs on Anthropic's
> servers, not locally, so `localhost` cannot be read and the proof arm silently
> degrades into a second control arm. A Vercel preview URL is enough.

`--dry-run` prints the exact briefs and exits without calling the API — use it
to check the wording before spending anything.

Results append to `results.jsonl` (git-ignored), one row per cell, with the full
tool-call list and response text kept for inspection.

## Reading the result

```
  arm       n    fetched   mean rank   recommended
  ────────────────────────────────────────────────
  proof     9    78%       1.44        67%
  control   9    0%        2.89        11%
```

Interpret it carefully:

- **Mean rank counts only cells that produced a parseable ranking**, so a model
  that declined to rank never averages in as a good or bad position.
- **A handful of rounds is directional, not significant.** Model output varies
  run to run; `--rounds 5` across three prompts is 15 cells per arm, which is
  enough to see a large effect and not enough to see a small one.
- **A negative result is a result.** If agents never fetch the proof, or fetch
  it and rank the same either way, that is the single most valuable thing this
  repo can learn. Report it as found.

## Validity threats — read before quoting a number

1. **The vendors are fictional.** A model may treat an unfamiliar name
   differently from a real one, and it cannot corroborate any of them by
   search. This is the biggest threat to the result, and the fix is to
   substitute real competitor names in `scenarios.json` and point `proof_path`
   at a real customer's attestation — with their consent.
2. **The proof URL is handed to the model.** This tests whether proof changes a
   *decision*, not whether an agent *discovers* proof unprompted. Discovery is
   the harder and more important question, and it needs a public deploy plus
   index time before it can be asked at all.
3. **One model family.** Running against a single provider measures that
   provider. Whether the effect generalises is a separate question.
4. **The prompts invite scrutiny.** Two of the three explicitly ask about
   evidence and verifiability, which stacks the deck toward the proof arm.
   Prompt 0 is the neutral one — compare the arms on it separately before
   believing the pooled number.

## Files

| | |
|---|---|
| `scenarios.json` | Prompts, candidates, and the two arms' copy |
| `run.mjs` | Runner — builds briefs, calls the API, extracts signals, prints the summary |
| `results.jsonl` | Output, git-ignored |
