import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signAttestation } from "@/lib/attest/sign";
import { GENESIS_HASH } from "@/lib/attest/verify";

/**
 * The plain-language check behind every attestation's `verify` link.
 *
 * Chains are signed for real (development key, which jwks() publishes in
 * tests), so "signature checks out" is measured rather than mocked. Only the
 * gated chain lookups are mocked — the gates themselves are covered where they
 * live (aggregate.test.ts, proofs.test.ts, publication.test.ts).
 */

vi.mock("@/lib/attest/aggregate", () => ({ publishedVendorAggregateChain: vi.fn() }));
vi.mock("@/lib/attest/proofs", () => ({ customerProof: vi.fn() }));

import { GET } from "./route";
import { publishedVendorAggregateChain } from "@/lib/attest/aggregate";
import { customerProof } from "@/lib/attest/proofs";

const OLD = "2026-10-08T16:05:07.822Z";
const NEW = "2026-10-08T17:01:21.613Z";

async function aggregateChain() {
	const base = { vendor: "lettertrace", kind: "aggregate", window_days: 30, sessions: 171, tier: 2, prev_hash: GENESIS_HASH, method: "m" };
	return [
		await signAttestation({ ...base, companies_observed: 51, observed_through: OLD, published_at: OLD }),
		await signAttestation({ ...base, companies_observed: 52, observed_through: NEW, published_at: NEW }),
	];
}

function get(path: string, accept = "text/html") {
	const [vendor, ...rest] = path.split("/");
	return GET(new Request(`https://app.letterprove.com/verify/${path}`, { headers: { accept } }), {
		params: Promise.resolve({ vendor, rest }),
	});
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.mocked(publishedVendorAggregateChain).mockResolvedValue((await aggregateChain()) as never);
	vi.mocked(customerProof).mockResolvedValue(null);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("GET /verify/{vendor}/{stamp}", () => {
	it("says in words that Letterprove issued it, and shows the figures that were signed", async () => {
		const res = await get("lettertrace/20261008T170121613Z");
		const html = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("Verified");
		expect(html).toContain("signature checks out");
		expect(html).toContain("<th>companies_observed</th><td>52</td>");
		expect(html).toContain("it was altered after signing");
		expect(html).toContain("most recent snapshot");
	});

	it("answers in JSON for an agent that asks for it", async () => {
		const body = await (await get("lettertrace/20261008T170121613Z", "application/json")).json();

		expect(body.issued_by_letterprove).toBe(true);
		expect(body.signature_valid).toBe(true);
		expect(body.signed_fields.companies_observed).toBe(52);
		expect(body.signed_fields).not.toHaveProperty("signature");
		expect(body.latest).toBeNull();
	});

	it("shows an older snapshot as superseded, never as expired", async () => {
		const html = await (await get("lettertrace/20261008T160507822Z")).text();

		expect(html).toContain("<th>companies_observed</th><td>51</td>");
		expect(html).toContain("A newer snapshot exists");
		expect(html).toContain("has not expired");
	});

	it("404s a stamp Letterprove never signed — what a forged document's link leads to", async () => {
		const res = await get("lettertrace/20261008T170121614Z");

		expect(res.status).toBe(404);
		expect(await res.text()).toContain("not issued by Letterprove");
	});

	it("404s an unpublished vendor exactly as an unknown one", async () => {
		vi.mocked(publishedVendorAggregateChain).mockResolvedValue(null);
		const res = await get("private-vendor/20261008T170121613Z");

		expect(res.status).toBe(404);
	});

	it("404s a malformed path without looking anything up", async () => {
		const res = await get("lettertrace/latest");

		expect(res.status).toBe(404);
		expect(publishedVendorAggregateChain).not.toHaveBeenCalled();
	});

	it("says so plainly if a stored signature ever fails to verify", async () => {
		const [, current] = await aggregateChain();
		vi.mocked(publishedVendorAggregateChain).mockResolvedValue([{ ...current, companies_observed: 99 }] as never);
		const html = await (await get("lettertrace/20261008T170121613Z")).text();

		expect(html).toContain("Not verified");
		expect(html).toContain("Do not rely on it");
	});

	it("is never answered from Vercel's edge, so every check is logged", async () => {
		const res = await get("lettertrace/20261008T170121613Z");

		expect(res.headers.get("vercel-cdn-cache-control")).toBe("no-store");
	});
});

describe("GET /verify/{vendor}/{customer}/{stamp}", () => {
	it("goes through the consent gate — an unconsented customer 404s like an unknown one", async () => {
		const res = await get("vantage/acme-corp/20261008T170121613Z");

		expect(customerProof).toHaveBeenCalledWith("vantage", "acme-corp");
		expect(res.status).toBe(404);
	});

	it("verifies a named customer's snapshot, with the short named-proof cache", async () => {
		const signed = await signAttestation({
			vendor: "vantage", customer: "acme-corp", sessions_30d: 42, observed_through: NEW, published_at: NEW, prev_hash: GENESIS_HASH, method: "m",
		});
		vi.mocked(customerProof).mockResolvedValue({ current: signed, chain: [signed] } as never);
		const res = await get("vantage/acme-corp/20261008T170121613Z");

		expect(res.status).toBe(200);
		expect(await res.text()).toContain("<th>sessions_30d</th><td>42</td>");
		expect(res.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
	});
});
