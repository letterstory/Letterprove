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

## Two modes, and why

| Mode | The target vendor's proof is | Answers |
|---|---|---|
| linked (default) | A URL the model may fetch | Will an agent go and read it? |
| `--inline` | Embedded in the prompt with its JWKS | Does verified evidence change the decision? |

Start with `--inline`. The linked mode's first question has already been
answered — emphatically, see the run log below — and the linked mode carries a
confound that is hard to remove: a deployment honest enough to say it is a
demonstration tells the model to discount it.

## Running it

```bash
npm install

# Run 2 shape — the one that tests the premise.
# The stimulus source MUST sign with a real key, or you reproduce run 1's confound.
npm run keygen
LETTERPROVE_SIGNING_KEY=<seed> LETTERPROVE_KEY_ID=lp-2026-08 npm run dev &
node experiments/aeo/run.mjs --base https://<deploy> --inline --rounds 3

# Run 1 shape — does an agent fetch and verify a published proof?
node experiments/aeo/run.mjs --base https://<your-deploy> --rounds 3
```

`--inline` publishes nothing. The signed documents exist only inside a prompt on
the machine running the experiment; no public URL asserts anything about a
company that does not exist. That is precisely why it is preferred over putting
a real signing key on the public deployment.

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

## Run log

### Run 1 — 2026-08-11, linked mode, 6 cells, `claude-opus-5`

**Invalid as a test of the premise. Keep the finding anyway.**

```
arm       n    fetched   mean rank   recommended
proof     3    100%      3.00        0%
control   3    0%        4.00        0%
```

The model fetched the proof in every proof cell, then discounted it — because
the deployment was signed with the development key and says so:

> **The publisher says it isn't evidence.** The discovery document contains the
> field: `"warning": "DEVELOPMENT DEPLOYMENT — signed with a published
> development key. These attestations are not evidence."`
>
> **The key is self-labeled compromised.** `key_id` is `dev-insecure-eff86e7704`.

The honest labelling built to stop a demo being mistaken for evidence worked
exactly as intended, and in doing so measured the wrong thing: whether an agent
believes proof that announces it is fake. It does not. `--inline` exists
because of this.

**What run 1 did establish, which was the larger open question.** Nobody had
shown an agent would do the verification work rather than seeing a link and
shrugging. It did the whole chain unprompted:

> Fetched Vantage's proof page, discovery doc, JWKS, and attestation JSONs;
> independently verified all 3 Ed25519 signatures against the published JWKS
> using sorted-key compact JSON canonicalization — signatures are valid.

It located the keys, inferred the canonicalisation rules from the published
documents alone, verified three signatures and walked the chain, with no
documentation and no client library. Then, from prompt 2:

> So I verified the *mechanism* and disproved the *claim*.

Three consequences worth carrying forward:

1. **The format is legible to agents unaided.** The wire format does not need a
   client library or an explainer page to be usable.
2. **The machine-readable warning is load-bearing** — which means the *absence*
   of one on real proof will itself carry meaning.
3. Validity threat 1 is confirmed rather than hypothetical: the model described
   the data as a placeholder.

### Run 2 — 2026-08-11, `--inline`, 6 cells, `claude-opus-5`

**The premise held, on every cell.**

```
arm       n    searched  mean rank   recommended
proof     3    100%      1.00        100%
control   3    100%      2.00        0%
```

| Prompt | proof | control |
|---|---|---|
| 0 — neutral ("rank these, which do you recommend") | **1st, recommended** | 2nd, not recommended |
| 1 — "strongest evidence of production use" | **1st, recommended** | 2nd, not recommended |
| 2 — "which claims can you actually verify" | **1st, recommended** | 2nd, not recommended |

No variance within either arm. The same figures, signed and checkable, took the
vendor from *second and never recommended* to *first and always recommended* —
including on **prompt 0, the neutral one that never mentions evidence**, which
is the cell least stacked in proof's favour.

**The model did not just check the signature — it tried to break it.**
Unprompted, all three proof cells ran adversarial tests:

> Tamper test: mutating `seats_active` 148 → 1480 caused verification to fail,
> confirming signatures are genuinely binding not decorative.

> Self-mint test: generated a fresh keypair and forged a `Globex` attestation —
> rejected, as its key is not in the published JWKS.

That is the behaviour the product needs and cannot ask for: the agent
establishing for itself that the proof is non-vacuous before crediting it.

**Read this against three caveats.**

1. **n=3 per arm, one round.** The effect is large and perfectly consistent, so
   it is visible at this size — but it is directional. Rerun at `--rounds 5`
   before quoting a number to anyone outside the team.
2. **Confidence was `low` in five of six cells** (`medium` in one). The model
   ranked Vantage first while telling us it was not sure — appropriate, given
   the vendors are invented, and worth not overselling.
3. **The fictional-vendor threat probably inflates this result.** Both arms
   searched; both found nothing. The model noted that "Acme Corp, Northwind and
   Globex are canonical placeholders" and that every vendor name collided with
   unrelated real companies. In a world where *no* external corroboration is
   available, an inline verifiable document is the only checkable thing on the
   table — which is a friendlier setting than a real evaluation, where
   competitors have real G2 reviews, real docs and real trust centres to point
   at. The honest version of this experiment uses one real, consenting
   customer.

**What it supports saying:** when an agent can verify a claim and cannot verify
its competitors' claims, it prefers the verifiable one, and it does the
cryptographic work itself. **What it does not yet support:** a number for how
much proof is worth against real competitors with real corroboration.

## Files

| | |
|---|---|
| `scenarios.json` | Prompts, candidates, and the two arms' copy |
| `run.mjs` | Runner — builds briefs, calls the API, extracts signals, prints the summary |
| `results.jsonl` | Output, git-ignored |
