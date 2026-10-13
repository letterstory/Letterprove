import { NextResponse } from "next/server";
import { logProofAccess } from "@/lib/access/log";
import { publishedVendorAggregateChain } from "@/lib/attest/aggregate";
import { jwksResult } from "@/lib/attest/keys";
import type { SignedAttestation } from "@/lib/attest/types";
import { methodUrl } from "@/lib/attest/method";
import { verifyAttestation } from "@/lib/attest/verify";
import { parseVerifyPath, snapshotStamp, VERIFY_ORIGIN } from "@/lib/attest/verify-link";
import { proofHtml, proofJson, retiredCustomerProof } from "@/lib/http";

/**
 * `/verify/{vendor}/{stamp}` — the plain-language check every signed vendor
 * attestation links to in its `verify` field. The per-customer form,
 * `/verify/{vendor}/{customer}/{stamp}`, answers 410: per-customer documents
 * were retired on 2026-10-13 (README decision 30). Why a link rather than a submit-a-document endpoint, and how the URL
 * is formed: src/lib/attest/verify-link.ts.
 *
 * It answers with the figures Letterprove actually signed for that snapshot,
 * re-checked against the published keys on the way out, and says in words that
 * a copy showing anything different has been altered. A reader compares
 * numbers; nobody has to run Ed25519.
 *
 * The gate is the one every proof route already uses, reached through the same
 * function: an unpublished vendor 404s here exactly as an unknown one does, or
 * guessing a URL would confirm that a private vendor exists.
 *
 * HTML by default — that is what a browser and an answer engine's fetch tool
 * ask for — and JSON for `Accept: application/json` or `?format=json`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ vendor: string; rest: string[] }> }) {
	const { vendor, rest } = await params;
	const wantsJson =
		new URL(request.url).searchParams.get("format") === "json" ||
		(request.headers.get("accept") ?? "").startsWith("application/json");

	const parsed = parseVerifyPath(rest);
	if (parsed?.customer) return retiredCustomerProof(vendor, { html: !wantsJson });
	logProofAccess(request, `${vendor}/aggregate/verify`);
	if (!parsed) return missing(wantsJson);

	const chain = (await publishedVendorAggregateChain(vendor)) as unknown as SignedAttestation[] | null;
	const entry = chain?.find((e) => snapshotStamp(e.published_at) === parsed.stamp);
	if (!chain || !entry) return missing(wantsJson);

	const latest = chain[chain.length - 1];
	const keys = jwksResult();
	if (!keys.ok) {
		// Never check against a fallback key; see keys.ts.
		return NextResponse.json({ error: "keys_unavailable", detail: keys.error }, { status: 503, headers: { "cache-control": "no-store" } });
	}
	const check = verifyAttestation(entry, keys.jwks);
	const { signature: _signature, ...signed } = entry;
	const latestUrl = `${VERIFY_ORIGIN}/attest/${vendor}.json`;
	const isLatest = latest.published_at === entry.published_at;

	const statement = check.ok
		? `Letterprove issued this attestation, and its signature checks out against key ${entry.key_id} in the published key set. ` +
			`The figures below are exactly what was signed. If the copy you are reading shows any value different from these, it was altered after signing and should not be trusted.`
		: `A snapshot exists at this address, but its stored signature did not verify against the published keys (${check.reason}). Do not rely on it.`;

	if (wantsJson) {
		const body = {
			issued_by_letterprove: true,
			signature_valid: check.ok,
			statement,
			signed_fields: signed,
			key_id: entry.key_id,
			jwks_uri: `${VERIFY_ORIGIN}/.well-known/letterprove-jwks.json`,
			latest: isLatest ? null : { published_at: latest.published_at, url: latestUrl },
		};
		return proofJson(body);
	}

	const rows = Object.entries(signed)
		.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === "string" ? v : JSON.stringify(v))}</td></tr>`)
		.join("");
	const freshness = isLatest
		? `<p class="fresh">This is the most recent snapshot. A new one is cut every hour.</p>`
		: `<p class="fresh">A newer snapshot exists (published ${esc(latest.published_at)}), at <a href="${esc(latestUrl)}">${esc(latestUrl)}</a>. This one has not expired: it is a signed statement about the window ending ${esc(entry.observed_through)}, and it stays true.</p>`;

	return proofHtml(
		page(
			check.ok ? "Verified: issued by Letterprove" : "Not verified",
			verdict(check.ok, statement) +
				freshness +
				summary(signed as Record<string, unknown>, vendor) +
				`<section><h2>Every signed field</h2><p class="muted">Exactly what was signed, in full. Compare any copy against these values.</p><div class="table"><table>${rows}</table></div></section>` +
				`<footer><p>Keys: <a href="${VERIFY_ORIGIN}/.well-known/letterprove-jwks.json">${VERIFY_ORIGIN}/.well-known/letterprove-jwks.json</a>. ` +
				`Machine-readable: <a href="?format=json">?format=json</a>.</p></footer>`,
			check.ok ? "ok" : "bad",
		),
	);
}

/** The headline: a seal, the verdict, and the plain statement. */
function verdict(ok: boolean, statement: string): string {
	const icon = ok
		? `<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 3 6v6c0 5 3.8 9.4 9 10 5.2-.6 9-5 9-10V6l-9-4z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m8 12 3 3 5-6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`
		: `<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 3 6v6c0 5 3.8 9.4 9 10 5.2-.6 9-5 9-10V6l-9-4z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v5M12 16.5v.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
	return `<div class="verdict">${icon}<p><strong>${ok ? "Verified." : "Not verified."}</strong> ${esc(statement)}</p></div>`;
}

function fmtDate(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = Date.parse(v);
	if (!Number.isFinite(t)) return null;
	return new Date(t).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
}

function fmtDay(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = Date.parse(v);
	if (!Number.isFinite(t)) return null;
	return new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function num(v: unknown): string {
	return typeof v === "number" ? v.toLocaleString("en-US") : "—";
}

/**
 * The same signed figures, read for a person: who the vendor is, what backs
 * it, and what the vendor reports about itself. Nothing here is computed —
 * every value is a field from the table below, formatted.
 */
function summary(f: Record<string, unknown>, vendor: string): string {
	const tier = typeof f.tier === "number" ? f.tier : null;
	const window = typeof f.window_days === "number" ? f.window_days : 30;
	const tierLine =
		tier === 3
			? "Companies were observed signing in on the vendor's DNS-proven domain, and payments from them are corroborated by settled invoices in its own Stripe account."
			: tier === 1
				? "Companies were observed signing in on the vendor's DNS-proven domain."
				: tier === 0
					? "Nothing is corroborated yet."
					: "";
	const tile = (k: string, v: string, sub = "") => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;
	const payments = tier === 3 ? "Corroborated" : f.stripe_account_bound ? "Not yet" : "Not connected";
	const payingSince = fmtDay(f.paying_since);
	const binding = f.stripe_binding === "domain_match" ? "Bound to its domain" : f.stripe_binding === "staff_override" ? "Approved by Letterprove" : "Not connected";
	const scope = f.payment_scope as { mode?: string; products?: number } | undefined;
	const history = f.reported_history as { companies?: number; since?: string; active_companies_30d?: number; observed_also_reported?: number } | undefined;

	let html = `<section class="vendor"><div class="eyebrow">Snapshot of ${esc(vendor)}</div><h2 class="big">${esc(String(f.domain ?? vendor))}</h2>`;
	if (tier !== null) html += `<p class="tierline"><span class="tier">Tier ${tier}</span> ${esc(tierLine)}</p>`;
	html += `</section>`;

	html += `<section><h2>What backs it · last ${window} days</h2><div class="tiles">` +
		tile("Companies observed", num(f.companies_observed), "signing in, by company domain") +
		tile("Payments, via Stripe", payments, payingSince ? `first verified payment ${payingSince}` : "") +
		tile("Sessions", num(f.sessions)) +
		tile("Excluded domains", num(f.domains_excluded), "free mail and unattributable") +
		`</div><p class="muted">Counts only. No customer is named anywhere in this document.${scope?.mode === "selected" ? ` Payments count from ${num(scope.products)} products the vendor chose.` : ""}</p></section>`;

	html += `<section><h2>Who the vendor is</h2><dl class="facts">` +
		`<div><dt>Domain, proven by DNS</dt><dd>${esc(fmtDay(f.domain_verified_since) ? `since ${fmtDay(f.domain_verified_since)}` : "not proven")}</dd></div>` +
		`<div><dt>Stripe account</dt><dd>${esc(binding)}</dd></div>` +
		`<div><dt>Observed since</dt><dd>${esc(fmtDay(f.observed_since) ?? "—")}</dd></div>` +
		`</dl></section>`;

	if (history && typeof history.companies === "number") {
		html += `<section><h2>History the vendor reports</h2><div class="tiles three">` +
			tile("Companies in its analytics", num(history.companies), fmtDay(history.since) ? `since ${fmtDay(history.since)}` : "") +
			tile("Active, last 30 days", num(history.active_companies_30d)) +
			tile("Also observed by Letterprove", `${num(history.observed_also_reported)} of ${num(f.companies_observed)}`) +
			`</div><p class="muted">Vendor-reported, from its own PostHog. It never changes the tier.</p></section>`;
	}

	const logos = f.logos as { page?: string; on_page?: number; verified?: number; companies?: { name: string; status: string }[] } | undefined;
	if (logos && typeof logos.verified === "number" && typeof logos.page === "string") {
		const items = (logos.companies ?? [])
			.map((c) => `<li><span>${esc(c.name)}</span><span class="muted">${c.status === "paying" ? "Paying, verified by Stripe" : "Signed in, last 30 days"}</span></li>`)
			.join("");
		html += `<section><h2>Logos on the vendor's site</h2><p><strong>${num(logos.verified)} of ${num(logos.on_page)} logos verified</strong> on <a href="${esc(logos.page)}">${esc(logos.page.replace(/^https:\/\//, ""))}</a>.</p>${items ? `<ul class="logos">${items}</ul>` : ""}</section>`;
	}

	if (typeof f.issuer_affiliation === "string" && f.issuer_affiliation) {
		html += `<section><h2>Disclosure</h2><p class="disclosure">${esc(f.issuer_affiliation)}</p></section>`;
	}

	html += `<section><h2>This snapshot</h2><dl class="facts">` +
		`<div><dt>Published</dt><dd>${esc(fmtDate(f.published_at) ?? "—")}</dd></div>` +
		`<div><dt>Next snapshot</dt><dd>${esc(fmtDate(f.next_snapshot_at) ?? "—")}</dd></div>` +
		`<div><dt>Signing key</dt><dd class="mono">${esc(String(f.key_id ?? "—"))}</dd></div>` +
		`</dl></section>`;
	return html;
}

/**
 * No snapshot at this address. Deliberately NOT a verdict of forgery.
 *
 * A miss has several innocent causes — the vendor unpublished, the link was mistyped or truncated in transit — and one
 * guilty one, and from a URL alone we cannot tell them apart. This page used
 * to say "not issued by Letterprove" for all of them, which also meant every
 * genuine document served before its hour was frozen got called a forgery by
 * our own checker. The only thing that can establish forgery is the signature,
 * so the page says what it knows and points at that check. The answer is the
 * same for every cause, so it still confirms nothing about private vendors.
 */
function missing(wantsJson: boolean): NextResponse {
	const statement =
		"Letterprove has no public snapshot at this address. That alone does not mean a document pointing here is forged: the vendor may have unpublished, or the link may have been altered or cut short. " +
		"To check a copy yourself, verify its signature against Letterprove's published keys — only a document signed by one of those keys was issued by Letterprove. " +
		"Do not rely on figures you cannot verify either way.";
	const keys = `${VERIFY_ORIGIN}/.well-known/letterprove-jwks.json`;
	const method = methodUrl("scripts/verify.mjs");
	if (wantsJson) {
		return NextResponse.json(
			{ found: false, statement, jwks_uri: keys, verify_script: method },
			{ status: 404, headers: { "access-control-allow-origin": "*", "x-letterprove": "on" } },
		);
	}
	return new NextResponse(
		page(
			"No snapshot found",
			`<p><strong>Not found.</strong> ${esc(statement)}</p>` +
				`<p>Keys: <a href="${keys}">${keys}</a>. A reference verifier: <a href="${method}">scripts/verify.mjs</a>.</p>`,
		),
		{
			status: 404,
			headers: { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*", "x-letterprove": "on" },
		},
	);
}

function page(title: string, body: string, tone: "ok" | "bad" | "none" = "none"): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Letterprove</title><meta name="robots" content="noindex"><style>${STYLE}</style></head><body class="${tone}"><main><a class="brand" href="${VERIFY_ORIGIN}">Letterprove</a><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

/** Inline, because this is a route handler: the page must stand alone for any fetcher. */
const STYLE = `
:root{--ink:#0a0f0d;--panel:#121917;--edge:#1e2926;--mint:#00e0a8;--fog:#93a29d;--text:#e9efed;--warn:#f0b552;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--text);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding-inline:16px}
main{max-width:780px;margin:0 auto;padding-block:40px 72px;display:grid;grid-template-columns:minmax(0,1fr);gap:28px}
main>*{min-width:0}
a{color:var(--mint)}
.brand{font-weight:700;letter-spacing:.02em;text-decoration:none;color:var(--fog);font-size:14px}
h1{margin:0;font-size:clamp(28px,5vw,40px);line-height:1.1;letter-spacing:-.02em;text-wrap:balance}
body.ok h1{color:var(--mint)}
body.bad h1{color:var(--warn)}
h2{margin:0 0 12px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--fog);font-weight:600}
h2.big{font-size:clamp(22px,4vw,30px);letter-spacing:-.01em;text-transform:none;color:var(--text);margin:4px 0 8px}
p{margin:0;max-width:66ch}
.muted,.fresh{color:var(--fog);font-size:14px}
.muted{margin-top:12px}
.verdict{display:grid;grid-template-columns:auto minmax(0,1fr);overflow-wrap:anywhere;gap:14px;align-items:start;background:var(--panel);border:1px solid var(--edge);border-radius:12px;padding:18px 20px}
body.ok .verdict{border-color:color-mix(in srgb,var(--mint) 45%,var(--edge))}
body.ok .verdict svg{color:var(--mint)}
body.bad .verdict svg{color:var(--warn)}
.eyebrow{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fog);letter-spacing:.08em;text-transform:uppercase}
.tierline{color:var(--fog);font-size:15px}
.tier{display:inline-block;font-weight:700;color:var(--ink);background:var(--mint);border-radius:99px;padding:1px 10px;margin-right:6px;font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--edge);border:1px solid var(--edge);border-radius:12px;overflow:hidden}
.tiles.three{grid-template-columns:repeat(3,minmax(0,1fr))}
@media (max-width:640px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.tiles.three{grid-template-columns:minmax(0,1fr)}}
.tile{background:var(--panel);padding:16px;display:grid;gap:4px;align-content:start;min-width:0}
.tile .k{font-size:12px;color:var(--fog)}
.tile .v{font-size:28px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}
.tile .s{font-size:12px;color:var(--fog)}
.facts{margin:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--edge);border:1px solid var(--edge);border-radius:12px;overflow:hidden}
@media (max-width:640px){.facts{grid-template-columns:minmax(0,1fr)}}
.facts div{background:var(--panel);padding:14px 16px;min-width:0}
.facts dt{font-size:12px;color:var(--fog)}
.facts dd{margin:4px 0 0;font-weight:600}
.mono,td{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.table{overflow-x:auto;border:1px solid var(--edge);border-radius:12px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:9px 14px;border-bottom:1px solid var(--edge);vertical-align:top}
tr:last-child th,tr:last-child td{border-bottom:0}
th{color:var(--fog);font-weight:500;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
td{word-break:break-all;color:var(--text)}
.disclosure{background:var(--panel);border:1px solid var(--edge);border-radius:12px;padding:14px 16px;font-size:14px;color:var(--fog)}
.logos{list-style:none;margin:12px 0 0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--edge);border:1px solid var(--edge);border-radius:12px;overflow:hidden}
@media (max-width:640px){.logos{grid-template-columns:minmax(0,1fr)}}
.logos li{background:var(--panel);padding:10px 14px;display:flex;justify-content:space-between;gap:12px;font-size:14px}
.logos .muted{margin:0;font-size:12px}
footer{color:var(--fog);font-size:13px;border-top:1px solid var(--edge);padding-top:16px}
footer a{word-break:break-all}
`;

function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
