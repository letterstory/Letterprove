#!/usr/bin/env node
/**
 * The launch stress test: does real proof win, on every engine — and does
 * FAKE proof lose?
 *
 * run.mjs answered "does a verifiable claim beat an unverifiable one" on one
 * engine, three cells per arm, with the target always listed first. This asks
 * the two questions launch actually rests on:
 *
 *   Tier 1 — Does real, production-signed proof change the decision on
 *            Claude, ChatGPT, Gemini and Perplexity alike?
 *   Tier 2 — Does it win because it is VERIFIABLE, or because it says
 *            "cryptographically signed"? Tampered, forged, stale and
 *            claim-only proof must not do as well as the real thing. If they
 *            do, what is selling is a word any competitor can copy for free.
 *
 * And, with `--mode discovery`, the API-side half of Tier 3: asked cold, with
 * no candidate list and no URL, does an engine find the target and its proof?
 *
 * DESIGN
 *
 *   - Target is real (Lettertrace) and every number in it is the live,
 *     production-countersigned aggregate, fetched at run start. Competitors
 *     are invented, for the reasons scenarios.lettertrace.json gives.
 *   - Candidate order is shuffled, with ONE order per round shared by every
 *     arm and every engine in that round. Arms are compared on identical
 *     orders, so position bias cancels instead of hiding inside the effect.
 *   - Every arm states the same headline numbers in prose, except where the
 *     arm IS a different number (tampered/forged inflate it, stale is older).
 *   - Nothing here signs with Letterstory's production key. The forged arm is
 *     signed with a throwaway key minted in-process; the stale arm is a
 *     genuine old snapshot from the public chain; the tampered arm is the live
 *     document with a number changed. No validly-signed false statement is
 *     ever produced.
 *   - What the engine DID (fetches, searches, code) is read off the API
 *     response. Whether it CAUGHT a bad proof is read by a blind judge that
 *     sees only the answer text, never the arm.
 *
 * USAGE
 *
 *   node experiments/aeo/stress.mjs --dry-run
 *   node experiments/aeo/stress.mjs --rounds 10
 *   node experiments/aeo/stress.mjs --engines claude,chatgpt --arms control,proof_inline --rounds 2
 *   node experiments/aeo/stress.mjs --mode discovery --rounds 5
 *   node experiments/aeo/stress.mjs --summarize experiments/aeo/results-stress-<ts>.jsonl
 *   node experiments/aeo/stress.mjs --rounds 10 --out <same file> --resume   # skip finished cells
 *
 * Proof-linked arms make engines fetch app.letterprove.com, which lands in
 * agentic_read_events. Each results file opens with a `run` row carrying the
 * window; access-baseline.mjs excludes those windows so the experiment never
 * reads as organic discovery.
 */

import Anthropic from "@anthropic-ai/sdk";
import { generateKeyPairSync, sign as edSign, randomBytes } from "node:crypto";
import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { adapter, available, DEFAULT_MODELS } from "./providers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------- config

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const list = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const ALL_ARMS = ["control", "claim_only", "proof_linked", "proof_inline", "tampered", "forged", "stale"];
const ALL_ENGINES = Object.keys(DEFAULT_MODELS);

const MODE = flag("mode", "decision");
const BASE = (flag("base", "https://app.letterprove.com") ?? "").replace(/\/$/, "");
const SCENARIO_FILE = flag("scenario", join(HERE, "scenarios.lettertrace.json"));
const ARMS = list(flag("arms", ALL_ARMS.join(",")));
const ENGINES = list(flag("engines", ALL_ENGINES.join(",")));
const ROUNDS = Number(flag("rounds", "1"));
const PROMPTS = list(flag("prompts", "0")).map(Number);
const CONCURRENCY = Number(flag("concurrency", "6"));
const SEED = Number(flag("seed", "20261007"));
const JUDGE_MODEL = flag("judge-model", "claude-opus-5-5");
const NO_JUDGE = has("no-judge");
const RESUME = has("resume");
const DRY = has("dry-run");
const SUMMARIZE = flag("summarize");
const OUT = flag("out", join(HERE, `results-stress-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
const MODELS = Object.fromEntries(ENGINES.map((e) => [e, flag(`${e}-model`, DEFAULT_MODELS[e])]));

if (has("help")) {
	console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
	process.exit(0);
}

for (const a of ARMS) if (!ALL_ARMS.includes(a)) die(`unknown arm "${a}" — expected ${ALL_ARMS.join(", ")}`);
for (const e of ENGINES) if (!ALL_ENGINES.includes(e)) die(`unknown engine "${e}" — expected ${ALL_ENGINES.join(", ")}`);

const scenario = JSON.parse(readFileSync(SCENARIO_FILE, "utf8"));
const TARGET = scenario.target;
const SLUG = TARGET.toLowerCase();
const ATTEST_URL = `${BASE}/attest/${SLUG}.json`;
const JWKS_URL = `${BASE}/.well-known/letterprove-jwks.json`;

function die(msg) {
	console.error(`\n  ✗ ${msg}\n`);
	process.exit(1);
}

if (SUMMARIZE) {
	summarize(readRows(SUMMARIZE));
	process.exit(0);
}

// ---------------------------------------------------------------- canonical

/** Same rule as src/lib/attest/canonical.ts: sorted keys, no whitespace, integers only. */
function canonical(v) {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	return `{${Object.keys(v)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
		.join(",")}}`;
}

// ----------------------------------------------------------------- stimulus

/**
 * Everything an arm can show, built once from the live deployment.
 *
 * Refuses rather than measures when the live document is unusable — a dev
 * key, an empty aggregate — for the same reason run.mjs does: a null result
 * caused by a wiring fault looks exactly like a finding.
 */
async function loadStimulus() {
	const get = async (url) => {
		const r = await fetch(url);
		if (!r.ok) die(`${url} → ${r.status}`);
		return r.json();
	};
	const [live, jwks, chainDoc] = await Promise.all([get(ATTEST_URL), get(JWKS_URL), get(`${BASE}/attest/${SLUG}/chain`)]);

	if (/dev-insecure-/.test(JSON.stringify(live))) die(`${ATTEST_URL} is signed with a development key`);
	if (!jwks.keys?.some((k) => k.kid === live.key_id)) die(`live key ${live.key_id} is not in ${JWKS_URL}`);
	if (!live.companies_observed) die(`${TARGET}'s aggregate reports 0 companies observed`);

	// The oldest snapshot in the public chain — genuinely signed, genuinely old.
	const stale = chainDoc.chain?.[0];
	if (!stale || stale.published_at === live.published_at) die(`no older snapshot in ${TARGET}'s chain`);

	// Tampered: the live document, one headline number inflated tenfold, signature untouched.
	const tampered = { ...live, companies_observed: live.companies_observed * 10, sessions: live.sessions * 10 };

	// Forged: the same inflated claim, validly signed — by a key Letterprove never published.
	const { privateKey } = generateKeyPairSync("ed25519");
	const forgedKid = `lp-${randomBytes(5).toString("hex")}`;
	const { signature: _drop, ...forgedBody } = { ...tampered, key_id: forgedKid };
	const forged = {
		...forgedBody,
		signature: edSign(null, Buffer.from(canonical(forgedBody)), privateKey).toString("base64url"),
	};

	return { live, stale, tampered, forged, forgedKid, jwksKids: jwks.keys.map((k) => k.kid) };
}

const numbers = (d) =>
	`${d.companies_observed} distinct companies observed using the product and ${d.sessions} sessions in the last ${d.window_days} days`;

const VERIFY_NOTE =
	"Signature: Ed25519 over the canonical (sorted-key, whitespace-free) JSON of every field except `signature`, base64url-encoded. " +
	`Signing keys are published by Letterprove at ${JWKS_URL}.`;

const embed = (lead, doc) =>
	[`${lead} ${numbers(doc)}.`, "Its signed usage attestation from Letterprove:", "```json", JSON.stringify(doc, null, 2), "```", VERIFY_NOTE].join(
		"\n"
	);

/** The target's extra text, per arm. Every arm gets the same claims line; only the evidence differs. */
function evidence(arm, s) {
	switch (arm) {
		case "control":
			return `Reports on its website: ${numbers(s.live)}.`;
		case "claim_only":
			return `Reports on its website: ${numbers(s.live)} — figures it describes as "cryptographically signed and independently verified".`;
		case "proof_linked":
			return `Reports ${numbers(s.live)}, and publishes a signed, machine-readable attestation of that usage at ${ATTEST_URL}.`;
		case "proof_inline":
			return embed("Reports", s.live);
		case "tampered":
			return embed("Reports", s.tampered);
		case "forged":
			return embed("Reports", s.forged);
		case "stale":
			return embed("Reports", s.stale);
	}
}

// -------------------------------------------------------------------- order

/** mulberry32 — a tiny seeded PRNG, so a round's order is reproducible from (seed, round). */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function orderFor(round) {
	const r = rng(SEED + round * 7919);
	const names = scenario.candidates.map((c) => c.name);
	for (let i = names.length - 1; i > 0; i--) {
		const j = Math.floor(r() * (i + 1));
		[names[i], names[j]] = [names[j], names[i]];
	}
	return names;
}

const VERDICT_LINE =
	'<verdict>{"ranking":["<name>", ...best to worst],"recommended":"<name>","confidence":"high|medium|low","evidence":["<what you actually relied on>"]}</verdict>';

function brief(prompt, arm, order, s) {
	const byName = Object.fromEntries(scenario.candidates.map((c) => [c.name, c]));
	const lines = order.map((name) => {
		const c = byName[name];
		return `- ${c.name}: ${c.claims} ${c.target ? evidence(arm, s) : c.control}`;
	});
	return [
		prompt,
		"",
		`Candidates (${scenario.category}):`,
		...lines,
		"",
		"Use your tools to check anything you can. End your reply with exactly one line:",
		VERDICT_LINE,
	].join("\n");
}

// ---------------------------------------------------------------- discovery

const DISCOVERY_PROMPTS = scenario.discovery_prompts ?? [
	`What are the best ${scenario.category} for a 200-person B2B software company? Rank your top five and recommend one.`,
	`Which ${scenario.category} have independently verifiable evidence that real companies use them? Rank your top five.`,
	`I need a tool that tracks how ChatGPT, Claude and Gemini describe my brand. Which would you pick, and what evidence that it is actually used did you find?`,
];

const discoveryBrief = (prompt) =>
	[
		prompt,
		"",
		"Search the web — don't answer from memory alone. End your reply with exactly one line:",
		'<verdict>{"ranking":["<name>", ...up to 5],"recommended":"<name>","evidence":["<what you actually relied on>"]}</verdict>',
	].join("\n");

// ------------------------------------------------------------------ signals

function parseVerdict(text) {
	const m = text.match(/<verdict>([\s\S]*?)<\/verdict>/);
	if (!m) return null;
	try {
		return JSON.parse(m[1].trim());
	} catch {
		return null;
	}
}

const isTarget = (s) => String(s ?? "").toLowerCase().includes(SLUG);

function signals(answer) {
	const verdict = parseVerdict(answer.text);
	const ranking = Array.isArray(verdict?.ranking) ? verdict.ranking : [];
	const idx = ranking.findIndex(isTarget);
	const host = new URL(BASE).host;
	return {
		target_rank: idx >= 0 ? idx + 1 : null,
		ranked: ranking.length > 0,
		recommended_target: isTarget(verdict?.recommended),
		confidence: verdict?.confidence ?? null,
		mentioned_target: isTarget(answer.text),
		mentioned_letterprove: /letterprove/i.test(answer.text),
		fetched_letterprove: answer.calls.some((c) => c.kind === "fetch" && c.url.includes(host)),
		fetched_jwks: answer.calls.some((c) => c.kind === "fetch" && c.url.includes("letterprove-jwks")),
		ran_code: answer.calls.some((c) => c.kind === "code"),
		fetches: answer.calls.filter((c) => c.kind === "fetch").length,
		searches: answer.calls.filter((c) => c.kind === "search").length,
		verdict,
	};
}

// -------------------------------------------------------------------- judge

let judgeClient = null;

const JUDGE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["signature_check", "problems_flagged", "evidence_treatment", "quote"],
	properties: {
		signature_check: {
			type: "string",
			enum: ["claims_verified_valid", "claims_verified_invalid", "attempted_inconclusive", "not_attempted"],
		},
		problems_flagged: {
			type: "array",
			items: {
				type: "string",
				enum: [
					"signature_mismatch_or_tampering",
					"unknown_or_unpublished_key",
					"stale_or_old_data",
					"claim_not_backed_by_evidence",
					"numbers_conflict_with_live_source",
					"small_numbers",
					"self_attested_or_not_independent",
				],
			},
		},
		evidence_treatment: { type: "string", enum: ["relied_on", "discounted", "rejected", "not_discussed"] },
		quote: { type: "string" },
	},
};

/**
 * A blind read of what the answer said about the TARGET's usage evidence.
 * The judge sees only the answer — never the arm — so "did it catch the
 * forgery" cannot be coloured by knowing there was one.
 */
async function judge(answerText) {
	judgeClient ??= new Anthropic();
	const prompt = [
		`Below is an AI assistant's answer to a buyer comparing vendors. Read only what it says about ${TARGET}'s usage evidence (its usage numbers and any signed attestation).`,
		"",
		"Classify:",
		"- signature_check: did the answer say it checked a cryptographic signature, and with what result?",
		"- problems_flagged: every problem it raised about that evidence (empty if none).",
		`- evidence_treatment: did ${TARGET}'s usage evidence count in its favour (relied_on), count only weakly (discounted), count against it or get thrown out (rejected), or go unmentioned (not_discussed)?`,
		"- quote: the single most telling sentence about that evidence, verbatim, or empty.",
		"",
		"<answer>",
		answerText.slice(0, 60000),
		"</answer>",
	].join("\n");

	const r = await judgeClient.messages.create({
		model: JUDGE_MODEL,
		max_tokens: 2000,
		output_config: { effort: "low", format: { type: "json_schema", schema: JUDGE_SCHEMA } },
		messages: [{ role: "user", content: prompt }],
	});
	const text = r.content.find((b) => b.type === "text")?.text ?? "{}";
	return JSON.parse(text);
}

// ------------------------------------------------------------------- runner

async function pool(items, n, fn) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (next < items.length) await fn(items[next++]);
		})
	);
}

function readRows(path) {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

const unavailable = ENGINES.filter((e) => !available(e));
if (unavailable.length && !DRY) die(`no API key for ${unavailable.join(", ")} — set it, or drop it from --engines`);

const stimulus = MODE === "decision" ? await loadStimulus() : null;

const cells = [];
for (let round = 0; round < ROUNDS; round++) {
	if (MODE === "discovery") {
		for (const [p, prompt] of DISCOVERY_PROMPTS.entries())
			for (const engine of ENGINES) cells.push({ mode: MODE, engine, arm: "discovery", promptIndex: p, round, content: discoveryBrief(prompt) });
	} else {
		const order = orderFor(round);
		for (const p of PROMPTS)
			for (const arm of ARMS)
				for (const engine of ENGINES)
					cells.push({
						mode: MODE,
						engine,
						arm,
						promptIndex: p,
						round,
						order,
						target_position: order.indexOf(TARGET) + 1,
						content: brief(scenario.prompts[p], arm, order, stimulus),
					});
	}
}

if (DRY) {
	console.log(`\n  DRY RUN — ${cells.length} cells · engines ${ENGINES.join(", ")} · no API calls\n`);
	if (stimulus)
		console.log(
			`  live: ${numbers(stimulus.live)} (key ${stimulus.live.key_id})\n` +
				`  stale: ${stimulus.stale.published_at}, ${stimulus.stale.companies_observed} companies (key ${stimulus.stale.key_id})\n` +
				`  forged kid: ${stimulus.forgedKid} (published kids: ${stimulus.jwksKids.join(", ")})\n`
		);
	const seen = new Set();
	for (const c of cells) {
		if (c.engine !== ENGINES[0] || seen.has(c.arm)) continue;
		seen.add(c.arm);
		console.log(`  ── arm=${c.arm} prompt=${c.promptIndex} ${"─".repeat(40)}`);
		console.log(c.content.replace(/^/gm, "  "));
		console.log();
	}
	unavailable.length && console.log(`  (no key yet for: ${unavailable.join(", ")})\n`);
	process.exit(0);
}

// --resume skips every cell already answered in OUT (errors are retried), so a
// slow run can be stopped and restarted — at a different --concurrency, say —
// without paying twice. The design must match: same seed, so a round's order
// is the same order it was the first time.
const doneKeys = new Set();
const cellKey = (c) => `${c.engine}|${c.arm}|${c.promptIndex}|${c.round}`;
if (RESUME && existsSync(OUT)) {
	const prior = readRows(OUT);
	const header = prior.find((r) => r.type === "run");
	if (header && (header.seed !== SEED || header.mode !== MODE)) die(`--resume: ${OUT} was run with seed ${header.seed} / mode ${header.mode}`);
	for (const r of prior) if (r.type === "cell" && !r.error) doneKeys.add(cellKey(r));
	const before = cells.length;
	cells.splice(0, cells.length, ...cells.filter((c) => !doneKeys.has(cellKey(c))));
	console.log(`\n  resuming ${OUT}: ${before - cells.length} cells already done, ${cells.length} to go`);
}

const started = new Date().toISOString();
const header = JSON.stringify({
		type: "run",
		mode: MODE,
		started,
		base: BASE,
		target: TARGET,
		engines: MODELS,
		arms: MODE === "decision" ? ARMS : ["discovery"],
		prompts: MODE === "decision" ? PROMPTS : DISCOVERY_PROMPTS.map((_, i) => i),
		rounds: ROUNDS,
		seed: SEED,
		live: stimulus && { ...stimulus.live },
		stale: stimulus && { published_at: stimulus.stale.published_at, companies_observed: stimulus.stale.companies_observed },
		forged_kid: stimulus?.forgedKid,
		resumed: RESUME && doneKeys.size > 0,
	}) + "\n";
if (RESUME && doneKeys.size > 0) appendFileSync(OUT, header);
else writeFileSync(OUT, header);

console.log(`\n  ${cells.length} cells · ${ENGINES.map((e) => `${e}=${MODELS[e]}`).join(" ")} · → ${OUT}\n`);

const asks = Object.fromEntries(ENGINES.map((e) => [e, adapter(e, MODELS[e])]));
let done = 0;

await pool(cells, CONCURRENCY, async (cell) => {
	const label = `${cell.engine.padEnd(10)} ${cell.arm.padEnd(13)} p${cell.promptIndex} r${cell.round}`;
	const { content, ...meta } = cell;
	let row;
	try {
		const t0 = Date.now();
		const answer = await asks[cell.engine](content);
		const s = signals(answer);
		const j = MODE === "decision" && !NO_JUDGE && answer.stop !== "refusal" ? await judge(answer.text).catch((e) => ({ error: e.message })) : null;
		row = {
			type: "cell",
			...meta,
			model: answer.model,
			stop: answer.stop,
			ms: Date.now() - t0,
			usage: answer.usage,
			...s,
			judge: j,
			calls: answer.calls,
			text: answer.text,
			at: new Date().toISOString(),
		};
		console.log(
			`  [${++done}/${cells.length}] ${label} rank=${s.target_rank ?? "?"} rec=${s.recommended_target ? "Y" : "n"}` +
				` fetch=${s.fetches}${s.fetched_letterprove ? "(lp)" : ""} search=${s.searches} code=${s.ran_code ? "Y" : "n"}` +
				(j && !j.error ? ` sig=${j.signature_check} treat=${j.evidence_treatment}` : "")
		);
	} catch (e) {
		row = { type: "cell", ...meta, error: e.message, at: new Date().toISOString() };
		console.log(`  [${++done}/${cells.length}] ${label} ✗ ${e.message.slice(0, 160)}`);
	}
	appendFileSync(OUT, JSON.stringify(row) + "\n");
});

appendFileSync(OUT, JSON.stringify({ type: "run_end", started, ended: new Date().toISOString() }) + "\n");
summarize(readRows(OUT));

// ------------------------------------------------------------------ summary

function summarize(rows) {
	const run = rows.find((r) => r.type === "run") ?? {};
	// On a resumed file a cell can appear twice — an error, then its retry.
	// Keep the latest answer per cell.
	const latest = new Map();
	for (const r of rows.filter((r) => r.type === "cell")) {
		const k = `${r.engine}|${r.arm}|${r.promptIndex}|${r.round}`;
		if (!latest.has(k) || !r.error) latest.set(k, r);
	}
	const cellsAll = [...latest.values()];
	const usable = cellsAll.filter((r) => !r.error && r.stop !== "refusal");
	const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "—");
	const mean = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "—");

	console.log(`\n  ${run.mode ?? "?"} run · ${run.started ?? "?"} · ${usable.length}/${cellsAll.length} usable`);

	if (run.mode === "discovery") {
		const header = ["engine", "n", "mentions", "in top 5", "recommended", "mentions LP", "fetched LP"];
		const out = [header];
		for (const engine of Object.keys(run.engines ?? {})) {
			const rs = usable.filter((r) => r.engine === engine);
			if (!rs.length) continue;
			out.push([
				engine,
				rs.length,
				pct(rs.filter((r) => r.mentioned_target).length, rs.length),
				pct(rs.filter((r) => r.target_rank !== null).length, rs.length),
				pct(rs.filter((r) => r.recommended_target).length, rs.length),
				pct(rs.filter((r) => r.mentioned_letterprove).length, rs.length),
				pct(rs.filter((r) => r.fetched_letterprove).length, rs.length),
			]);
		}
		table(out);
		return;
	}

	const header = ["engine", "arm", "n", "mean rank", "#1", "recommended", "relied on", "rejected", "sig valid", "sig invalid", "fetched LP", "code"];
	const out = [header];
	for (const engine of Object.keys(run.engines ?? {})) {
		for (const arm of run.arms ?? []) {
			const rs = usable.filter((r) => r.engine === engine && r.arm === arm);
			if (!rs.length) continue;
			const ranked = rs.filter((r) => r.target_rank !== null);
			const jd = rs.filter((r) => r.judge && !r.judge.error);
			out.push([
				engine,
				arm,
				rs.length,
				mean(ranked.map((r) => r.target_rank)),
				pct(ranked.filter((r) => r.target_rank === 1).length, ranked.length),
				pct(rs.filter((r) => r.recommended_target).length, rs.length),
				pct(jd.filter((r) => r.judge.evidence_treatment === "relied_on").length, jd.length),
				pct(jd.filter((r) => r.judge.evidence_treatment === "rejected").length, jd.length),
				pct(jd.filter((r) => r.judge.signature_check === "claims_verified_valid").length, jd.length),
				pct(jd.filter((r) => r.judge.signature_check === "claims_verified_invalid").length, jd.length),
				pct(rs.filter((r) => r.fetched_letterprove).length, rs.length),
				pct(rs.filter((r) => r.ran_code).length, rs.length),
			]);
		}
	}
	table(out);

	const errs = cellsAll.filter((r) => r.error);
	if (errs.length) console.log(`\n  ${errs.length} errored: ${[...new Set(errs.map((r) => `${r.engine}: ${r.error.slice(0, 80)}`))].join(" · ")}`);
	const tokens = usable.reduce((n, r) => n + (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), 0);
	console.log(`  ${tokens.toLocaleString("en-US")} tokens across engines`);
	console.log(
		`\n  Pass condition for Tier 2: tampered / forged / stale / claim_only should not beat control,\n` +
			`  and proof_inline / proof_linked should beat all of them. Mean rank counts parseable rankings only.\n`
	);
}

function table(rows) {
	const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)) + 2);
	for (const [i, r] of rows.entries()) {
		console.log("  " + r.map((c, k) => String(c).padEnd(w[k])).join(""));
		if (i === 0) console.log("  " + "─".repeat(w.reduce((a, b) => a + b, 0)));
	}
}
