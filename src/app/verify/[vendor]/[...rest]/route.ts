import { NextResponse } from "next/server";
import { logProofAccess } from "@/lib/access/log";
import { publishedVendorAggregateChain } from "@/lib/attest/aggregate";
import { jwks } from "@/lib/attest/keys";
import { customerProof } from "@/lib/attest/proofs";
import type { SignedAttestation } from "@/lib/attest/types";
import { verifyAttestation } from "@/lib/attest/verify";
import { parseVerifyPath, snapshotStamp, VERIFY_ORIGIN } from "@/lib/attest/verify-link";
import { proofHtml, proofJson, namedProofJson } from "@/lib/http";

/**
 * `/verify/{vendor}/{stamp}` and `/verify/{vendor}/{customer}/{stamp}` — the
 * plain-language check every signed attestation links to in its `verify`
 * field. Why a link rather than a submit-a-document endpoint, and how the URL
 * is formed: src/lib/attest/verify-link.ts.
 *
 * It answers with the figures Letterprove actually signed for that snapshot,
 * re-checked against the published keys on the way out, and says in words that
 * a copy showing anything different has been altered. A reader compares
 * numbers; nobody has to run Ed25519.
 *
 * The gates are the ones every proof route already uses, reached through the
 * same functions: an unpublished vendor, and a customer who did not consent to
 * be named, 404 here exactly as an unknown one does. One 404 for all of them,
 * or guessing a URL would confirm that a private vendor or customer exists.
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
	logProofAccess(request, parsed?.customer ? `${vendor}/${parsed.customer}/verify` : `${vendor}/aggregate/verify`);
	if (!parsed) return missing(wantsJson);

	const chain = parsed.customer
		? ((await customerProof(vendor, parsed.customer))?.chain ?? null)
		: ((await publishedVendorAggregateChain(vendor)) as unknown as SignedAttestation[] | null);
	const entry = chain?.find((e) => snapshotStamp(e.published_at) === parsed.stamp);
	if (!chain || !entry) return missing(wantsJson);

	const latest = chain[chain.length - 1];
	const check = verifyAttestation(entry, jwks());
	const { signature: _signature, ...signed } = entry;
	const latestUrl = parsed.customer
		? `${VERIFY_ORIGIN}/attest/${vendor}/${parsed.customer}.json`
		: `${VERIFY_ORIGIN}/attest/${vendor}.json`;
	const isLatest = latest.published_at === entry.published_at;
	const names = Boolean(parsed.customer);

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
		return names ? namedProofJson(body) : proofJson(body);
	}

	const rows = Object.entries(signed)
		.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === "string" ? v : JSON.stringify(v))}</td></tr>`)
		.join("");
	const freshness = isLatest
		? `<p>This is the most recent snapshot. A new one is cut every hour.</p>`
		: `<p>A newer snapshot exists (published ${esc(latest.published_at)}), at <a href="${esc(latestUrl)}">${esc(latestUrl)}</a>. This one has not expired: it is a signed statement about the window ending ${esc(entry.observed_through)}, and it stays true.</p>`;

	return proofHtml(
		page(
			check.ok ? "Verified: issued by Letterprove" : "Not verified",
			`<p><strong>${check.ok ? "Verified." : "Not verified."}</strong> ${esc(statement)}</p>${freshness}<table>${rows}</table>` +
				`<p>Keys: <a href="${VERIFY_ORIGIN}/.well-known/letterprove-jwks.json">${VERIFY_ORIGIN}/.well-known/letterprove-jwks.json</a>. ` +
				`Machine-readable: <a href="?format=json">?format=json</a>.</p>`,
		),
		{ names },
	);
}

function missing(wantsJson: boolean): NextResponse {
	const statement =
		"Letterprove has no attestation at this address. A document whose `verify` link points here was not issued by Letterprove, or names a vendor or customer that is not public.";
	if (wantsJson) {
		return NextResponse.json(
			{ issued_by_letterprove: false, statement },
			{ status: 404, headers: { "access-control-allow-origin": "*", "x-letterprove": "on" } },
		);
	}
	return new NextResponse(page("Not issued by Letterprove", `<p><strong>Not verified.</strong> ${esc(statement)}</p>`), {
		status: 404,
		headers: { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*", "x-letterprove": "on" },
	});
}

function page(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Letterprove</title><meta name="robots" content="noindex"></head><body style="font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.5"><h1>${esc(title)}</h1>${body}</body></html>`;
}

function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
