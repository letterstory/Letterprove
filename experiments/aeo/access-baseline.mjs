#!/usr/bin/env node
/**
 * Tier 3 — are answer engines reading proof on their own?
 *
 * stress.mjs hands an engine the proof and asks whether it changes the
 * answer. This asks the harder question from the other side: with nobody
 * prompting them, do ChatGPT, Claude, Perplexity and Gemini fetch our proof
 * endpoints at all? The answer is in production's agentic_read_events — every
 * AI-agent read of a /proofs or /attest route, classified by user-agent
 * (src/lib/access/classify.ts) and checked against the operator's published IP
 * ranges (`verified`).
 *
 *   node experiments/aeo/access-baseline.mjs                 # all retained history
 *   node experiments/aeo/access-baseline.mjs --since 2026-10-01
 *   node experiments/aeo/access-baseline.mjs --vendor lettertrace
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the table is
 * service-role only), e.g. `set -a; source .env.local; set +a`.
 *
 * WHAT IT EXCLUDES. stress.mjs's proof arms make engines fetch these routes on
 * purpose. Every results-stress-*.jsonl in this directory records when it ran;
 * reads inside those windows (plus slack) are split out as "experiment" so a
 * test never reads as organic discovery.
 *
 * WHAT IT CANNOT SEE — read before quoting a number:
 *   1. Edge-cached reads. Until PR #162, proof responses were cached by
 *      Vercel's CDN for an hour and a cache HIT never reached the logger. Every
 *      count before that fix ships is a LOWER BOUND: at most the first read per
 *      URL per hour.
 *   2. Reads of proof served through a vendor's own domain that do not reach
 *      us, and anything an engine answers from its own index without
 *      fetching. An engine can cite proof it read weeks ago; this logs fetches,
 *      not citations.
 *   3. Requests with no recognisable AI user-agent (only `kind === "ai_agent"`
 *      is recorded durably). Gemini's url_context fetcher is one of these.
 *
 * Writes a snapshot to access-baseline-<date>.json (git-ignored): the table is
 * pruned at 65 days, so the snapshot is the baseline that survives.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const SINCE = flag("since");
const VENDOR = flag("vendor");
const SLACK_MS = 15 * 60 * 1000;
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
	console.error("\n  ✗ set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (production)\n");
	process.exit(1);
}

// ------------------------------------------------------------------- read

async function readEvents() {
	const rows = [];
	for (let from = 0; ; from += 1000) {
		const q = new URLSearchParams({ select: "vendor_slug,subject,agent_name,verified,receipt_ts", order: "receipt_ts.asc" });
		if (SINCE) q.append("receipt_ts", `gte.${SINCE}`);
		if (VENDOR) q.append("vendor_slug", `eq.${VENDOR}`);
		const res = await fetch(`${URL_}/rest/v1/agentic_read_events?${q}`, {
			headers: { apikey: KEY, authorization: `Bearer ${KEY}`, range: `${from}-${from + 999}` },
		});
		if (!res.ok) throw new Error(`agentic_read_events → ${res.status} ${await res.text()}`);
		const page = await res.json();
		rows.push(...page);
		if (page.length < 1000) return rows;
	}
}

/** [start, end] of every stress.mjs run on this machine, padded by SLACK_MS. */
function experimentWindows() {
	const windows = [];
	for (const f of readdirSync(HERE).filter((f) => /^results-stress-.*\.jsonl$/.test(f))) {
		const rows = readFileSync(join(HERE, f), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const times = rows.flatMap((r) => [r.started, r.ended, r.at]).filter(Boolean).map((t) => Date.parse(t));
		if (times.length) windows.push({ file: f, start: Math.min(...times) - SLACK_MS, end: Math.max(...times) + SLACK_MS });
	}
	return windows;
}

/** "vendor", "vendor/aggregate", "vendor/aggregate/chain", "vendor/customer", "vendor/customer/chain". */
function surface(subject) {
	const parts = subject.split("/");
	if (parts.length === 1) return "proofs page";
	if (parts[1] === "aggregate") return parts[2] === "chain" ? "aggregate chain" : "aggregate";
	return parts[2] === "chain" ? "customer chain" : "customer";
}

const isoWeek = (ts) => {
	const d = new Date(ts);
	d.setUTCHours(0, 0, 0, 0);
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
	return d.toISOString().slice(0, 10);
};

// ------------------------------------------------------------------ report

const events = await readEvents();
const windows = experimentWindows();
const inExperiment = (ts) => windows.some((w) => Date.parse(ts) >= w.start && Date.parse(ts) <= w.end);
const organic = events.filter((e) => !inExperiment(e.receipt_ts));
const experiment = events.filter((e) => inExperiment(e.receipt_ts));

const tally = (rows, key) => {
	const m = new Map();
	for (const r of rows) {
		const k = key(r);
		const t = m.get(k) ?? { reads: 0, verified: 0, first: r.receipt_ts, last: r.receipt_ts };
		t.reads++;
		if (r.verified) t.verified++;
		t.last = r.receipt_ts;
		m.set(k, t);
	}
	return Object.fromEntries([...m].sort((a, b) => b[1].reads - a[1].reads));
};

// A "visit" is one engine reading one vendor's proof within ten minutes — one
// answer being researched, however many URLs it touched. That is closer to
// "times an engine looked" than raw reads, which a single chain walk inflates.
function visits(rows) {
	const out = [];
	for (const r of rows) {
		const last = out.findLast((v) => v.agent === r.agent_name && v.vendor === r.vendor_slug);
		if (last && Date.parse(r.receipt_ts) - Date.parse(last.end) < 10 * 60 * 1000) {
			last.end = r.receipt_ts;
			last.reads++;
			last.surfaces.add(surface(r.subject));
		} else {
			out.push({ agent: r.agent_name, vendor: r.vendor_slug, start: r.receipt_ts, end: r.receipt_ts, reads: 1, verified: r.verified, surfaces: new Set([surface(r.subject)]) });
		}
	}
	return out.map((v) => ({ ...v, surfaces: [...v.surfaces] }));
}

const snapshot = {
	taken_at: new Date().toISOString(),
	filters: { since: SINCE, vendor: VENDOR },
	caveat: "Lower bound until PR #162 (edge-cache bypass) ships: CDN hits were never logged.",
	totals: { all: events.length, organic: organic.length, experiment: experiment.length },
	experiment_windows: windows.map((w) => ({ file: w.file, start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() })),
	organic: {
		by_agent: tally(organic, (r) => r.agent_name),
		by_vendor: tally(organic, (r) => r.vendor_slug),
		by_surface: tally(organic, (r) => surface(r.subject)),
		by_week: tally(organic, (r) => isoWeek(r.receipt_ts)),
		visits: visits(organic),
	},
	experiment: { by_agent: tally(experiment, (r) => r.agent_name) },
};

const fmt = (obj, label) => {
	const rows = Object.entries(obj);
	if (!rows.length) return console.log(`  ${label}: none`);
	console.log(`  ${label}`);
	for (const [k, t] of rows)
		console.log(`    ${k.padEnd(18)}${String(t.reads).padStart(5)} reads  ${String(t.verified).padStart(4)} verified   ${t.first.slice(0, 10)} → ${t.last.slice(0, 10)}`);
};

console.log(`\n  agentic_read_events — ${events.length} reads retained (${organic.length} organic, ${experiment.length} inside experiment windows)\n`);
fmt(snapshot.organic.by_agent, "organic, by engine");
console.log();
fmt(snapshot.organic.by_vendor, "organic, by vendor");
console.log();
fmt(snapshot.organic.by_surface, "organic, by surface");
console.log();
fmt(snapshot.organic.by_week, "organic, by week");
console.log(`\n  organic visits (one engine, one vendor, reads within 10 min): ${snapshot.organic.visits.length}`);
for (const v of snapshot.organic.visits)
	console.log(`    ${v.start.slice(0, 16)}  ${v.agent.padEnd(10)} ${v.vendor.padEnd(16)} ${v.reads} reads  ${v.verified ? "verified" : "unverified"}  ${v.surfaces.join(", ")}`);
console.log();
fmt(snapshot.experiment.by_agent, "experiment windows, by engine");

const out = join(HERE, `access-baseline-${snapshot.taken_at.slice(0, 10)}.json`);
writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`\n  ${snapshot.caveat}\n  → ${out}\n`);
