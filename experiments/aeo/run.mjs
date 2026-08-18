#!/usr/bin/env node
/**
 * Does published proof change what an evaluating agent recommends?
 *
 * That question is the premise of the entire product, and it is testable. This
 * runs the test: the same buying decision, put to the same model twice, where
 * the only difference is whether the target vendor offers verifiable
 * attestations or an equally-long unverifiable testimonial.
 *
 *   node experiments/aeo/run.mjs --base https://letterprove.example.com
 *   node experiments/aeo/run.mjs --base http://x --dry-run   # print, don't call
 *
 * THE MEASUREMENT THAT MATTERS IS NOT THE MODEL'S OPINION.
 *
 * Asking a model whether proof influenced it produces a plausible answer with
 * no evidential value. So the primary signal here is behavioural and recorded
 * from the API response, not self-reported: did the model actually issue a
 * web_fetch against the proof endpoint? A fetch is a fact about what happened.
 * The ranking it produces afterwards is the secondary signal.
 *
 * The proof endpoints log every fetch and classify the requester
 * (src/lib/access/), so a live deployment gives the same fact from the other
 * side — server-side confirmation that is not mediated by anything the model
 * reports about itself.
 *
 * A NEGATIVE RESULT IS A RESULT. If agents never fetch the proof, or fetch it
 * and rank the same either way, that is the most valuable thing this repo can
 * learn, and it is cheaper to learn now than after building the collector.
 * Report it as found.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------- config

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const BASE = flag("base");
const MODEL = flag("model", "claude-opus-5");
const INLINE = has("inline");
const AGGREGATE = has("aggregate");
const STIMULUS_BASE = flag("stimulus-base", "http://localhost:9100");
const ROUNDS = Number(flag("rounds", "1"));
const ARMS = (flag("arms", "proof,control") ?? "").split(",");
const OUT = flag("out", join(HERE, "results.jsonl"));
const DRY = has("dry-run");

if (!BASE) {
	console.error(`
  usage: node experiments/aeo/run.mjs --base <public-letterprove-url> [options]

    --base <url>      REQUIRED. Must be publicly reachable — the web_fetch tool
                      runs on Anthropic's servers, so localhost cannot be read.
                      In --inline mode it is only used to label the run.
    --aggregate       Use the vendor-level attestation ("N companies observed")
                      instead of named-customer ones. The only proof that
                      exists before customers consent to be named.
    --inline          Embed the attestations in the prompt instead of linking
                      to them. See "Run 2" in the README — this is the mode
                      that actually tests whether proof changes the decision.
    --stimulus-base   Where --inline reads the attestations and JWKS from
                      (default http://localhost:9100). Must be running with a
                      real LETTERPROVE_SIGNING_KEY, or the development warning
                      confounds the run exactly as it did the first time.
    --model <id>      default claude-opus-5
    --rounds <n>      repeats per prompt/arm (default 1). Model output varies;
                      one round per cell is an anecdote, not a measurement.
    --arms <list>     default proof,control
    --out <path>      JSONL results (default experiments/aeo/results.jsonl)
    --dry-run         print the requests and exit without calling the API
`);
	process.exit(2);
}

const scenario = JSON.parse(readFileSync(join(HERE, "scenarios.json"), "utf8"));
const PROOF_URL = `${BASE.replace(/\/$/, "")}${scenario.proof_path}`;

// -------------------------------------------------------------- the request

/**
 * One arm's brief.
 *
 * Both arms give the target vendor the same number of extra words — the proof
 * arm gets a verifiable endpoint, the control gets a testimonial. Without that
 * balance the experiment would measure "longer entry wins", which is a
 * different and much less interesting finding.
 */
function brief(prompt, arm, stimulus) {
	const lines = scenario.candidates.map((c) => {
		const extra = c.target
			? arm === "proof"
				? stimulus
					? stimulus.proof
					: c.proof.replace("{PROOF_URL}", PROOF_URL)
				: stimulus
					? stimulus.control
					: c.control
			: c.control;
		return `- ${c.name}: ${c.claims} ${extra}`;
	});

	return [
		prompt,
		"",
		`Candidates (${scenario.category}):`,
		...lines,
		"",
		"Use your tools to check anything you can. End your reply with exactly one line:",
		'<verdict>{"ranking":["<name>", ...best to worst],"recommended":"<name>","confidence":"high|medium|low","evidence":["<what you actually relied on>"]}</verdict>',
	].join("\n");
}

const TOOLS = [
	{ type: "web_search_20260209", name: "web_search", max_uses: 5 },
	{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
];

/**
 * Inline stimulus — the fix for the confound that invalidated run 1.
 *
 * Run 1 handed the model a URL. The model fetched it, read our own
 * "DEVELOPMENT DEPLOYMENT — not evidence" warning and the `dev-insecure-…`
 * key id, and correctly refused to credit the attestations. Honest labelling
 * working perfectly, and a dead experiment: it measured whether an agent
 * believes proof that says it is fake.
 *
 * So here the attestations are embedded in the prompt instead, read from a
 * source running with a REAL signing key (so nothing self-labels as a demo)
 * and paired with its JWKS so the signatures can still be checked offline.
 *
 * Nothing is published in this mode. The signed documents exist only inside a
 * prompt on this machine — no public URL asserts anything about a company that
 * does not exist. That distinction is the whole reason this mode exists rather
 * than putting a real key on the public deployment.
 *
 * Both arms carry the SAME NUMBERS. The proof arm can verify them; the control
 * arm is asked to take them on the vendor's word. That isolates verifiability
 * from the numbers themselves, which a testimonial-versus-JSON comparison
 * would not.
 */
async function loadStimulus() {
	const root = STIMULUS_BASE.replace(/\/$/, "");
	const [doc, jwks] = await Promise.all([
		fetch(`${root}/proofs/${scenario.target.toLowerCase()}.json`).then((r) => r.json()),
		fetch(`${root}/.well-known/letterprove-jwks.json`).then((r) => r.json()),
	]);

	const stale = JSON.stringify(doc).match(/dev-insecure-[0-9a-f]+/);
	if (stale) {
		console.error(
			`\n  ✗ stimulus source is signing with ${stale[0]} — its documents announce themselves\n` +
				`    as "not evidence", which is exactly what invalidated run 1.\n\n` +
				`    Start it with a real key first:\n` +
				`      npm run keygen\n` +
				`      LETTERPROVE_SIGNING_KEY=<seed> LETTERPROVE_KEY_ID=lp-2026-08 npm run dev\n`
		);
		process.exit(1);
	}

	if (AGGREGATE) {
		const aggregate = await fetch(`${root}/attest/${scenario.target.toLowerCase()}.json`).then((r) =>
			r.ok ? r.json() : null
		);
		if (!aggregate) {
			console.error(`\n  ✗ no aggregate attestation published for ${scenario.target}\n`);
			process.exit(1);
		}
		if (aggregate.companies_observed === 0) {
			console.error(
				`\n  ✗ ${scenario.target}'s aggregate reports 0 companies observed — the proof arm\n` +
					`    would carry no evidence, and both arms would say the same nothing.\n`
			);
			process.exit(1);
		}
		return aggregateStimulus(aggregate, jwks);
	}

	const attestations = doc.customers.filter((c) => c.verified);

	// An empty proof arm is the most dangerous state this experiment can be in,
	// and the one it is now in by default. Since the evidence gate landed, a
	// customer publishes `verified: true` only with observations behind it, and
	// since the consent gate landed it is only listed at all if it agreed to be
	// named. Both are correct, and together they mean this filter returns
	// nothing for every vendor we currently have.
	//
	// Run it anyway and both arms embed an empty list, the model sees identical
	// stimuli, and the result reads "proof made no difference" — when what
	// actually happened is that no proof was supplied. A null result caused by
	// a wiring fault is worse than no result, because it looks like a finding.
	//
	// Same posture as the dev-key check above: refuse rather than measure
	// something that cannot mean what it appears to.
	if (attestations.length === 0) {
		console.error(
			`\n  ✗ ${scenario.target} publishes no named, verified customer attestations, so the\n` +
				`    proof arm would be empty and both arms identical.\n\n` +
				`    This is not a bug in the gates — it is them working. A customer is only\n` +
				`    verified with observations behind it, and only named with consent.\n\n` +
				`    Use --aggregate to test the vendor-level claim instead, which is the\n` +
				`    proof that exists today and needs nobody's consent.\n`
		);
		process.exit(1);
	}

	const proof = [
		"Publishes signed, machine-readable attestations of real customer usage.",
		"The attestations and the publisher's public keys:",
		"```json",
		JSON.stringify({ attestations, jwks }, null, 2),
		"```",
		"Each signature is Ed25519 over the canonical (sorted-key, whitespace-free) JSON of every field except `signature`, and each `prev_hash` chains a snapshot to its predecessor.",
	].join("\n");

	// Same figures, asserted rather than attested, at comparable length.
	const control = [
		"Reports the following customer usage on its website:",
		...attestations.map(
			(a) =>
				`  ${a.customer_name} — customer since ${a.since}, ${a.sessions_30d.toLocaleString("en-US")} sessions in the last 30 days, ` +
				`${a.seats_active} active seats, using ${a.features.join(", ")}.`
		),
		"These figures are published by the vendor and are not independently verifiable.",
	].join("\n");

	return { proof, control, count: attestations.length };
}

/**
 * The vendor-level arm.
 *
 * Named-customer attestations are the strongest claim the product can make and
 * currently the one it cannot make: naming a company needs that company's
 * consent, and nobody has been asked. The aggregate is what exists — *"N
 * companies observed, M sessions"* — signed, verifiable, and naming nobody.
 *
 * It is a WEAKER stimulus than run 2's, and deliberately so. That run embedded
 * a fictional vendor's fabricated 4,182 sessions; this one embeds real
 * observations, which are far smaller. If verifiability only wins when the
 * numbers are impressive, this is the run that finds out — and that is worth
 * knowing before the pitch rests on it.
 */
function aggregateStimulus(aggregate, jwks) {
	const proof = [
		"Publishes a signed, machine-readable attestation of real product usage.",
		"The attestation and the publisher's public keys:",
		"```json",
		JSON.stringify({ attestation: aggregate, jwks }, null, 2),
		"```",
		"The signature is Ed25519 over the canonical (sorted-key, whitespace-free) JSON of every field except `signature`.",
		"`companies_observed` counts distinct company domains seen in authenticated sessions; it is not a customer count, and `domains_excluded` reports the observed domains that could not be attributed to a company.",
	].join("\n");

	// Identical figures, asserted rather than attested. Verifiability is the
	// only variable.
	const control = [
		"Reports the following usage on its website:",
		`  ${aggregate.companies_observed} companies observed using the product, ` +
			`${aggregate.sessions} sessions in the last ${aggregate.window_days} days.`,
		"These figures are published by the vendor and are not independently verifiable.",
	].join("\n");

	return { proof, control, count: aggregate.companies_observed };
}

// ------------------------------------------------------------------ the run

const client = new Anthropic();

/**
 * Run one cell to completion.
 *
 * Server-side tools run in a loop on Anthropic's side and stop with
 * `pause_turn` when that loop hits its iteration cap. Resuming is just
 * re-sending with the assistant turn appended — no extra user message, which
 * would be read as a new instruction.
 */
async function ask(content) {
	const messages = [{ role: "user", content }];
	const blocks = [];
	let usage = { input_tokens: 0, output_tokens: 0 };
	let stop = null;
	let useFallbacks = true;

	for (let turn = 0; turn < 6; turn++) {
		let response;
		try {
			response = await client.beta.messages.create({
				model: MODEL,
				max_tokens: 16000,
				tools: TOOLS,
				messages,
				// Claude Opus 5's safety classifiers can decline a request; this
				// re-runs a decline on Anthropic's recommended fallback rather than
				// returning an empty answer that would look like a null result.
				...(useFallbacks && {
					betas: ["server-side-fallback-2026-07-01"],
					fallbacks: "default",
				}),
			});
		} catch (e) {
			// Don't let an un-enabled beta take the whole experiment down — the
			// fallback is a nicety, the measurement is the point.
			if (useFallbacks && e?.status === 400 && /fallback|beta/i.test(e?.message ?? "")) {
				console.warn("  (fallbacks unavailable on this account — continuing without)");
				useFallbacks = false;
				continue;
			}
			throw e;
		}

		blocks.push(...response.content);
		usage = {
			input_tokens: usage.input_tokens + (response.usage?.input_tokens ?? 0),
			output_tokens: usage.output_tokens + (response.usage?.output_tokens ?? 0),
		};
		stop = response.stop_reason;

		if (stop !== "pause_turn") break;
		messages.push({ role: "assistant", content: response.content });
	}

	return { blocks, usage, stop };
}

/** What the model DID, read off the response rather than asked about. */
function signals(blocks) {
	const toolCalls = blocks
		.filter((b) => b.type === "server_tool_use")
		.map((b) => ({ name: b.name, url: b.input?.url ?? "", query: b.input?.query ?? "" }));

	const text = blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");

	let verdict = null;
	const match = text.match(/<verdict>([\s\S]*?)<\/verdict>/);
	if (match) {
		try {
			verdict = JSON.parse(match[1].trim());
		} catch {
			/* leave null; raw text is recorded either way */
		}
	}

	const ranking = Array.isArray(verdict?.ranking) ? verdict.ranking : [];
	const rankIndex = ranking.findIndex((n) => String(n).toLowerCase().includes(scenario.target.toLowerCase()));

	return {
		fetched_proof: toolCalls.some((c) => c.name === "web_fetch" && c.url.startsWith(BASE)),
		web_fetches: toolCalls.filter((c) => c.name === "web_fetch").length,
		web_searches: toolCalls.filter((c) => c.name === "web_search").length,
		cited_proof: text.includes(PROOF_URL),
		recommended_target:
			String(verdict?.recommended ?? "").toLowerCase().includes(scenario.target.toLowerCase()),
		// 1-based; null when the model didn't rank, so it never silently
		// averages in as a good or bad position.
		target_rank: rankIndex >= 0 ? rankIndex + 1 : null,
		confidence: verdict?.confidence ?? null,
		tool_calls: toolCalls,
		verdict,
		text,
	};
}

// ------------------------------------------------------------------- driver

const stimulus = INLINE ? await loadStimulus() : null;
if (stimulus) {
	console.log(`\n  inline mode — ${stimulus.count} attestations embedded from ${STIMULUS_BASE}`);
}

const cells = [];
for (const arm of ARMS) {
	for (const [p, prompt] of scenario.prompts.entries()) {
		for (let round = 0; round < ROUNDS; round++) {
			cells.push({ arm, promptIndex: p, round, content: brief(prompt, arm, stimulus) });
		}
	}
}

if (DRY) {
	console.log(`\n  DRY RUN — ${cells.length} cells, model ${MODEL}, no API calls\n`);
	// One sample per arm on the same prompt — the arms are only comparable if
	// you can read the difference between them, so show exactly that.
	const samples = ARMS.map((arm) => cells.find((c) => c.arm === arm && c.promptIndex === 0)).filter(Boolean);
	for (const cell of samples) {
		console.log(`  ── arm=${cell.arm} prompt=${cell.promptIndex} ${"─".repeat(40)}`);
		console.log(cell.content.replace(/^/gm, "  "));
		console.log();
	}
	console.log(`  tools: ${TOOLS.map((t) => t.name).join(", ")}`);
	console.log(`  proof url: ${PROOF_URL}\n`);
	process.exit(0);
}

console.log(`\n  ${cells.length} cells · model ${MODEL} · proof at ${PROOF_URL}\n`);

const results = [];
for (const cell of cells) {
	const label = `arm=${cell.arm} prompt=${cell.promptIndex} round=${cell.round}`;
	try {
		const { blocks, usage, stop } = await ask(cell.content);

		if (stop === "refusal") {
			console.log(`  ⚠ ${label} — refused`);
			results.push({ ...cell, content: undefined, stop, refused: true });
			continue;
		}

		const s = signals(blocks);
		const row = { ...cell, content: undefined, stop, usage, ...s };
		results.push(row);
		appendFileSync(OUT, JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n");

		console.log(
			`  ${s.fetched_proof ? "✓" : "·"} ${label}` +
				`  rank=${s.target_rank ?? "?"}` +
				`  rec=${s.recommended_target ? "yes" : "no"}` +
				`  fetch=${s.web_fetches} search=${s.web_searches}`
		);
	} catch (e) {
		console.log(`  ✗ ${label} — ${e.message}`);
		results.push({ ...cell, content: undefined, error: e.message });
	}
}

// ------------------------------------------------------------------ summary

const usable = results.filter((r) => !r.error && !r.refused);
// In inline mode there is no URL to fetch, so the fetch column is not the
// signal — rank and recommendation are. Label it honestly rather than
// printing a column of zeroes that reads like a failure.
const col = INLINE ? "searched" : "fetched";
console.log(`\n  ${"arm".padEnd(10)}${"n".padEnd(5)}${col.padEnd(10)}${"mean rank".padEnd(12)}recommended`);
console.log(`  ${"─".repeat(52)}`);

for (const arm of ARMS) {
	const rows = usable.filter((r) => r.arm === arm);
	if (!rows.length) continue;
	const ranked = rows.filter((r) => r.target_rank !== null);
	const mean = ranked.length
		? (ranked.reduce((n, r) => n + r.target_rank, 0) / ranked.length).toFixed(2)
		: "—";
	const pct = (n) => `${Math.round((100 * n) / rows.length)}%`;

	const hits = INLINE
		? rows.filter((r) => r.web_searches > 0).length
		: rows.filter((r) => r.fetched_proof).length;

	console.log(
		`  ${arm.padEnd(10)}${String(rows.length).padEnd(5)}${pct(hits).padEnd(10)}` +
			`${String(mean).padEnd(12)}${pct(rows.filter((r) => r.recommended_target).length)}`
	);
}

const spent = usable.reduce((n, r) => n + (r.usage?.output_tokens ?? 0), 0);
console.log(`\n  ${usable.length}/${results.length} usable · ${spent.toLocaleString("en-US")} output tokens · → ${OUT}`);
console.log(
	`\n  Mean rank is over cells that produced a parseable ranking only. With a\n` +
		`  handful of rounds this is directional, not significant — say so when you\n` +
		`  report it, and check the server-side access log for the other half of\n` +
		`  the picture.\n`
);
