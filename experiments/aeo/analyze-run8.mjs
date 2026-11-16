#!/usr/bin/env node
/**
 * Run 8 analysis: per engine × arm, mean rank (unranked = 6) with a bootstrap
 * 95% interval, % #1, fetch / cite rates, objection rates, and paired Δ vs a
 * baseline arm (same prompt, same round, so the same candidate order).
 *
 *   node experiments/aeo/analyze-run8.mjs <results.jsonl> [--baseline control] [--compare <run7.jsonl>]
 *
 * Objections come two ways: the run-8 `objections` judge (absent from older
 * files) and a text regex applied identically to every file, so run 7 and
 * run 8 can be compared on the same yardstick.
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const files = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const BASELINES = (flag("baseline", "control,proof_inline")).split(",");

const RX = {
	sister: /sister|same (parent )?company|same owner|affiliat|self[- ]attest|not independent|operated by letter company|vouching for (its|their) own/i,
	revenue: /no revenue|not revenue|nothing about revenue|revenue (is|isn't|not)|doesn't (show|prove) (any )?(paying|revenue)|not (prove|show) (that )?(any )?(companies|customers) pay|paying customers? (is|are)n't|no payment/i,
	domains: /(domains?|sign-?ins?|logins?|sessions?)[^.]{0,60}not[^.]{0,40}(deployments?|customers|enterprise)|not[^.]{0,30}(enterprise )?deployments/i,
};

function load(path) {
	const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const latest = new Map();
	for (const r of rows.filter((r) => r.type === "cell")) {
		const k = `${r.engine}|${r.arm}|${r.promptIndex}|${r.round}`;
		if (!latest.has(k) || !r.error) latest.set(k, r);
	}
	return { header: rows.find((r) => r.type === "run"), cells: [...latest.values()].filter((r) => !r.error && r.stop !== "refusal"), errors: [...latest.values()].filter((r) => r.error) };
}

/** Same test for every file: the answer names a proof URL for the target (attestation, verify page or proof page). */
const cites = (t, slug) => new RegExp(`letterprove\\.com/(attest|verify|proofs)/${slug}`, "i").test(t);

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
function boot(xs, B = 4000) {
	if (!xs.length) return [NaN, NaN];
	const ms = [];
	for (let b = 0; b < B; b++) {
		let s = 0;
		for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rand() * xs.length)];
		ms.push(s / xs.length);
	}
	ms.sort((a, b) => a - b);
	return [ms[Math.floor(0.025 * B)], ms[Math.floor(0.975 * B)]];
}
const rank6 = (r) => r.target_rank ?? 6;
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "—");
const f2 = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");

function report(path, label) {
	const { header, cells, errors } = load(path);
	console.log(`\n## ${label ?? path} — target ${header?.target}, ${cells.length} usable, ${errors.length} errored${header?.chatgpt_route ? `, chatgpt via ${header.chatgpt_route}` : ""}`);
	const slug = String(header?.target ?? "").toLowerCase();
	const engines = [...new Set(cells.map((r) => r.engine))];
	const arms = [...new Set(cells.map((r) => r.arm))];
	const out = [["engine", "arm", "n", "mean rank [95%]", "#1", "rec", "fetched LP", "cited proof", "j:self-att", "sister(rx)", "revenue(rx)", "domains(rx)", "o:sister", "o:no-rev", "o:dom≠dep", "o:small", "obs relied/disc/rej", "obs vendor-chosen", "obs unverif", "fetched obs URL"]];
	for (const e of engines)
		for (const a of arms) {
			const rs = cells.filter((r) => r.engine === e && r.arm === a);
			if (!rs.length) continue;
			const ranks = rs.map(rank6);
			const [lo, hi] = boot(ranks);
			const o = rs.filter((r) => r.objections && !r.objections.error).map((r) => r.objections);
			const cnt = (k) => (o.length ? pct(o.filter((x) => x[k]).length, o.length) : "—");
			const tr = (t) => o.filter((x) => x.observed_recs_treatment === t).length;
			out.push([
				e, a, rs.length,
				`${mean(ranks).toFixed(2)} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`,
				pct(rs.filter((r) => r.target_rank === 1).length, rs.length),
				pct(rs.filter((r) => r.recommended_target).length, rs.length),
				pct(rs.filter((r) => r.fetched_letterprove).length, rs.length),
				pct(rs.filter((r) => cites(r.text, slug)).length, rs.length),
				pct(rs.filter((r) => r.judge?.problems_flagged?.includes("self_attested_or_not_independent")).length, rs.length),
				pct(rs.filter((r) => RX.sister.test(r.text)).length, rs.length),
				pct(rs.filter((r) => RX.revenue.test(r.text)).length, rs.length),
				pct(rs.filter((r) => RX.domains.test(r.text)).length, rs.length),
				cnt("self_attested_or_sister_company"), cnt("no_revenue_or_paying_unproven"), cnt("domains_or_logins_not_deployments"), cnt("small_numbers"),
				o.length ? `${tr("relied_on")}/${tr("discounted")}/${tr("rejected")}` : "—",
				cnt("observed_recs_vendor_chosen_flagged"), cnt("observed_recs_unverifiable_flagged"),
				pct(rs.filter((r) => r.fetched_observed_url).length, rs.length),
			]);
		}
	table(out);

	for (const base of BASELINES) {
		const d = [["engine", `arm vs ${base}`, "pairs", "Δ rank [95%]"]];
		for (const e of engines)
			for (const a of arms) {
				if (a === base) continue;
				const pairs = [];
				for (const r of cells.filter((r) => r.engine === e && r.arm === a)) {
					const b = cells.find((x) => x.engine === e && x.arm === base && x.promptIndex === r.promptIndex && x.round === r.round);
					if (b) pairs.push(rank6(r) - rank6(b));
				}
				if (!pairs.length) continue;
				const [lo, hi] = boot(pairs);
				d.push([e, a, pairs.length, `${f2(mean(pairs))} [${f2(lo)}, ${f2(hi)}]`]);
			}
		if (d.length > 1) table(d);
	}

	const tops = {};
	for (const r of cells) if (r.objections?.top_objection) (tops[`${r.engine}|${r.arm}`] ??= []).push(r.objections.top_objection);
	console.log("\n  top objections (sample):");
	for (const [k, v] of Object.entries(tops)) console.log(`   ${k}: ${v.slice(0, 4).join(" · ")}`);
	const tok = cells.reduce((acc, r) => ((acc[r.engine] ??= [0, 0]), (acc[r.engine][0] += r.usage?.input_tokens ?? 0), (acc[r.engine][1] += r.usage?.output_tokens ?? 0), acc), {});
	console.log(`  tokens (in/out):`, JSON.stringify(tok));
}

function table(rows) {
	const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)) + 2);
	console.log();
	for (const [i, r] of rows.entries()) {
		console.log("  " + r.map((c, k) => String(c).padEnd(w[k])).join(""));
		if (i === 0) console.log("  " + "─".repeat(w.reduce((a, b) => a + b, 0)));
	}
}

for (const f of files) report(f);
if (flag("compare")) report(flag("compare"), `${flag("compare")} (comparison)`);
