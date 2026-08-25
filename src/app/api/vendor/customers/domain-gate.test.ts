import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { PATCH } from "./[slug]/route";

vi.mock("@/lib/vendors/session", () => ({ currentVendor: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ createServerSupabaseClient: vi.fn() }));

/**
 * Enough of the supabase chain for insert().select().single(), update()…
 * maybeSingle(), and the vendors-table read the domain gate does before
 * every check (.from("vendors").select("domain").eq("id", ...).maybeSingle()).
 * The caller's own vendor domain defaults to a non-Letter-Company one, since
 * these tests are exercising the domain gate for an ordinary, external vendor.
 */
function mockSupabase(vendorDomain = "acme-vendor.com") {
	const row = { id: "c1", slug: "acme", name: "Acme", domain: "acme.com" };
	const single = vi.fn().mockResolvedValue({ data: row, error: null });
	const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
	const select = vi.fn().mockReturnValue({ single, maybeSingle });
	const eq2 = vi.fn().mockReturnValue({ select });
	const eq1 = vi.fn().mockReturnValue({ eq: eq2, select });
	const insert = vi.fn().mockReturnValue({ select });
	const update = vi.fn().mockReturnValue({ eq: eq1 });

	const vendorMaybeSingle = vi.fn().mockResolvedValue({ data: { domain: vendorDomain }, error: null });
	const vendorEq = vi.fn().mockReturnValue({ maybeSingle: vendorMaybeSingle });
	const vendorSelect = vi.fn().mockReturnValue({ eq: vendorEq });

	const from = vi.fn((table: string) => (table === "vendors" ? { select: vendorSelect } : { insert, update }));
	return { from, insert, update, vendorMaybeSingle };
}

function createReq(domain: string, consent = "named") {
	return new Request("https://app.letterprove.com/api/vendor/customers", {
		method: "POST",
		body: JSON.stringify({ slug: "acme", name: "Acme", domain, since: "2024-01", consent }),
	});
}

function patchReq(domain: string) {
	return new Request("https://app.letterprove.com/api/vendor/customers/acme", {
		method: "PATCH",
		body: JSON.stringify({ domain }),
	});
}
const PARAMS = { params: Promise.resolve({ slug: "acme" }) };

let db: ReturnType<typeof mockSupabase>;

beforeEach(async () => {
	vi.clearAllMocks();
	const { currentVendor } = await import("@/lib/vendors/session");
	const { createServerSupabaseClient } = await import("@/lib/auth/server");
	vi.mocked(currentVendor).mockResolvedValue({ id: "v1" } as never);
	db = mockSupabase();
	vi.mocked(createServerSupabaseClient).mockResolvedValue(db as never);
});

// A customer record on a domain that can never name a company is not a
// data-entry slip — it becomes a signed, immutable claim, and the chain cannot
// be rewritten afterwards.
describe("customer domain gate — create", () => {
	it("accepts a real company domain", async () => {
		const res = await POST(createReq("acme.com"));
		expect(res.status).toBe(201);
		expect(db.insert).toHaveBeenCalled();
	});

	it("refuses free-mail, which real telemetry produces within the hour", async () => {
		const res = await POST(createReq("gmail.com"));
		expect(res.status).toBe(422);
		expect((await res.json()).kind).toBe("free_mail");
		expect(db.insert).not.toHaveBeenCalled();
	});

	// Dogfooding puts our own domains in the same table as customers, and
	// attesting our own usage of our own product — one Letter Company vendor
	// claiming another as its customer — is self-dealing.
	it("refuses our own domains when the calling vendor is also ours", async () => {
		const { createServerSupabaseClient } = await import("@/lib/auth/server");
		vi.mocked(createServerSupabaseClient).mockResolvedValue(mockSupabase("lettertrace.com") as never);

		const res = await POST(createReq("letterbrace.com"));
		expect(res.status).toBe(422);
		expect((await res.json()).kind).toBe("internal");
	});

	// Not a privileged position: a genuinely external vendor verifying The
	// Letter Company as a real customer goes through the exact same gate and
	// consent flow as any other company.
	it("allows our domain as a real customer of a vendor that isn't ours", async () => {
		const res = await POST(createReq("letterbrace.com"));
		expect(res.status).toBe(201);
		expect(db.insert).toHaveBeenCalledWith(expect.objectContaining({ domain: "letterbrace.com" }));
	});

	it("refuses fixtures and probes", async () => {
		expect((await POST(createReq("acme-corp.example"))).status).toBe(422);
		expect((await POST(createReq("probe.invalid"))).status).toBe(422);
		expect(db.insert).not.toHaveBeenCalled();
	});

	// The refusal has to say why, or whoever typed it learns nothing and
	// wonders later why the record never publishes.
	it("explains the refusal rather than failing opaquely", async () => {
		const body = await (await POST(createReq("gmail.com"))).json();
		expect(body.reason).toBeTruthy();
		expect(body.error).toContain("gmail.com");
	});

	// classifyDomain proposes generously: real customers are exactly the
	// domains no list can enumerate, so anything unrecognised is allowed.
	it("allows a company nobody has heard of", async () => {
		expect((await POST(createReq("some-startup-nobody-knows.io"))).status).toBe(201);
	});
});

// Gating only creation would leave the rule trivially bypassable: make a
// customer on a real domain, then edit it to gmail.com.
describe("customer domain gate — edit", () => {
	it("accepts a move to another real company domain", async () => {
		const res = await PATCH(patchReq("newname.com"), PARAMS);
		expect(res.status).toBe(200);
		expect(db.update).toHaveBeenCalled();
	});

	it("refuses an edit onto an unattributable domain", async () => {
		const res = await PATCH(patchReq("gmail.com"), PARAMS);
		expect(res.status).toBe(422);
		expect(db.update).not.toHaveBeenCalled();
	});

	it("refuses an edit onto our own domain when the calling vendor is also ours", async () => {
		const { createServerSupabaseClient } = await import("@/lib/auth/server");
		vi.mocked(createServerSupabaseClient).mockResolvedValue(mockSupabase("letterstory.com") as never);

		expect((await PATCH(patchReq("letterstory.com"), PARAMS)).status).toBe(422);
		expect(db.update).not.toHaveBeenCalled();
	});

	it("allows an edit onto our domain for a vendor that isn't ours", async () => {
		const res = await PATCH(patchReq("letterstory.com"), PARAMS);
		expect(res.status).toBe(200);
		expect(db.update).toHaveBeenCalled();
	});
});
