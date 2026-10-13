import { describe, expect, it } from "vitest";
import { GET as getCustomer } from "./route";
import { GET as getChain } from "./chain/route";

// Per-customer documents were retired on 2026-10-13 (README decision 30).
// Every slug answers 410 with the same statement, so a URL confirms nothing
// about who was a customer, and none of it is called a forgery.
describe("retired per-customer routes", () => {
	const params = (customer: string) => ({ params: Promise.resolve({ vendor: "acme", customer }) });

	it.each([
		["document", () => getCustomer(new Request("https://app.letterprove.com/attest/acme/globex.json"), params("globex.json"))],
		["chain", () => getChain(new Request("https://app.letterprove.com/attest/acme/globex/chain"), params("globex"))],
	])("the %s answers 410 with a statement and the vendor attestation", async (_label, call) => {
		const res = await call();
		expect(res.status).toBe(410);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		const body = await res.json();
		expect(body.error).toBe("gone");
		expect(body.statement).toMatch(/retired on 2026-10-13/);
		expect(body.statement).toMatch(/does not mean any document pointing here was forged/);
		expect(body.vendor_proof).toBe("https://app.letterprove.com/attest/acme.json");
	});

	it("says the same thing for any slug, real or not", async () => {
		const a = await (await getCustomer(new Request("https://x/attest/acme/real"), params("real"))).json();
		const b = await (await getCustomer(new Request("https://x/attest/acme/nope"), params("nope"))).json();
		expect(a).toEqual(b);
		expect(JSON.stringify(a)).not.toMatch(/real|nope/);
	});
});
