import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupConsentRequest, recordConsentDecision } from "./consent";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/rollup/snapshots", () => ({ currentSnapshot: vi.fn() }));

const VENDOR = { id: "v1", name: "Acme Inc" };
const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

/** Builds a from() mock that branches on table name, single-select-eq-maybeSingle style. */
function mockDb({
	vendor,
	customer,
	updateResult,
}: {
	vendor?: unknown;
	customer?: unknown;
	updateResult?: { data: unknown; error: unknown };
}) {
	const vendorMaybeSingle = vi.fn().mockResolvedValue({ data: vendor ?? null });
	const vendorEq = vi.fn().mockReturnValue({ maybeSingle: vendorMaybeSingle });
	const vendorSelect = vi.fn().mockReturnValue({ eq: vendorEq });

	const customerMaybeSingle = vi.fn().mockResolvedValue({ data: customer ?? null });
	const customerEq2 = vi.fn().mockReturnValue({ maybeSingle: customerMaybeSingle });
	const customerEq1 = vi.fn().mockReturnValue({ eq: customerEq2 });
	const customerSelect = vi.fn().mockReturnValue({ eq: customerEq1 });

	const updateMaybeSingle = vi.fn().mockResolvedValue(updateResult ?? { data: null, error: null });
	const updateSelect = vi.fn().mockReturnValue({ maybeSingle: updateMaybeSingle });
	const updateGt = vi.fn().mockReturnValue({ select: updateSelect });
	const updateEq3 = vi.fn().mockReturnValue({ gt: updateGt });
	const updateEq2 = vi.fn().mockReturnValue({ eq: updateEq3 });
	const updateEq1 = vi.fn().mockReturnValue({ eq: updateEq2 });
	const update = vi.fn().mockReturnValue({ eq: updateEq1 });

	const from = vi.fn((table: string) => {
		if (table === "vendors") return { select: vendorSelect };
		return { select: customerSelect, update };
	});
	return { from, update };
}

beforeEach(() => vi.clearAllMocks());

describe("lookupConsentRequest", () => {
	it("reports invalid when there's no service-role client", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		expect(await lookupConsentRequest("acme", "cust", "tok")).toEqual({ status: "invalid" });
	});

	it("reports invalid when the vendor slug doesn't resolve", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ vendor: null }) as never);

		expect(await lookupConsentRequest("acme", "cust", "tok")).toEqual({ status: "invalid" });
	});

	it("reports invalid when the customer slug doesn't resolve under that vendor", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ vendor: VENDOR, customer: null }) as never);

		expect(await lookupConsentRequest("acme", "cust", "tok")).toEqual({ status: "invalid" });
	});

	it("reports already_countersigned ahead of a token mismatch, so a reopened link after approval reads correctly", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(
			mockDb({
				vendor: VENDOR,
				customer: {
					name: "Widgets Co",
					domain: "widgets.co",
					since: "2026-01-01",
					features: [],
					consent_token: null,
					consent_token_expires_at: null,
					countersigned_at: PAST,
				},
			}) as never,
		);

		expect(await lookupConsentRequest("acme", "widgets", "stale-token")).toEqual({
			status: "already_countersigned",
			customerName: "Widgets Co",
		});
	});

	it("reports invalid when the token doesn't match", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(
			mockDb({
				vendor: VENDOR,
				customer: {
					name: "Widgets Co",
					domain: "widgets.co",
					since: "2026-01-01",
					features: [],
					consent_token: "real-token",
					consent_token_expires_at: FUTURE,
					countersigned_at: null,
				},
			}) as never,
		);

		expect(await lookupConsentRequest("acme", "widgets", "wrong-token")).toEqual({ status: "invalid" });
	});

	it("reports expired when the token matches but its expiry has passed", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(
			mockDb({
				vendor: VENDOR,
				customer: {
					name: "Widgets Co",
					domain: "widgets.co",
					since: "2026-01-01",
					features: [],
					consent_token: "tok",
					consent_token_expires_at: PAST,
					countersigned_at: null,
				},
			}) as never,
		);

		expect(await lookupConsentRequest("acme", "widgets", "tok")).toEqual({ status: "expired" });
	});

	it("builds a live preview with real telemetry when the token is valid", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(dbClient).mockReturnValue(
			mockDb({
				vendor: VENDOR,
				customer: {
					name: "Widgets Co",
					domain: "widgets.co",
					since: "2026-01-01",
					features: ["sso"],
					consent_token: "tok",
					consent_token_expires_at: FUTURE,
					countersigned_at: null,
				},
			}) as never,
		);
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-21T00:00:00Z",
			published_at: "2026-08-21T00:00:00Z",
			sessions_30d: 42,
			seats_active: 5,
			observed: true,
			readOk: true,
		});

		expect(await lookupConsentRequest("acme", "widgets", "tok")).toEqual({
			status: "ready",
			preview: {
				vendorSlug: "acme",
				vendorName: "Acme Inc",
				customerSlug: "widgets",
				customerName: "Widgets Co",
				domain: "widgets.co",
				since: "2026-01-01",
				features: ["sso"],
				sessions30d: 42,
				seatsActive: 5,
			},
		});
	});
});

describe("recordConsentDecision", () => {
	it("fails invalid when there's no service-role client", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		expect(await recordConsentDecision("acme", "widgets", "tok", "approve")).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("fails invalid when the vendor slug doesn't resolve", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ vendor: null }) as never);

		expect(await recordConsentDecision("acme", "widgets", "tok", "approve")).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("fails invalid when the scoped update matches no row (bad token, expired, or already used)", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(
			mockDb({ vendor: VENDOR, updateResult: { data: null, error: null } }) as never,
		);

		expect(await recordConsentDecision("acme", "widgets", "tok", "approve")).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("sets consent=named and countersigned_at on approve", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const db = mockDb({ vendor: VENDOR, updateResult: { data: { id: "c1" }, error: null } });
		vi.mocked(dbClient).mockReturnValue(db as never);

		const result = await recordConsentDecision("acme", "widgets", "tok", "approve");

		expect(result).toEqual({ ok: true });
		expect(db.update).toHaveBeenCalledWith(
			expect.objectContaining({ consent: "named", consent_token: null, consent_token_expires_at: null }),
		);
		expect(db.update.mock.calls[0][0].countersigned_at).toEqual(expect.any(String));
	});

	it("only clears the token on decline, leaving consent and countersigned_at untouched", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const db = mockDb({ vendor: VENDOR, updateResult: { data: { id: "c1" }, error: null } });
		vi.mocked(dbClient).mockReturnValue(db as never);

		const result = await recordConsentDecision("acme", "widgets", "tok", "decline");

		expect(result).toEqual({ ok: true });
		expect(db.update).toHaveBeenCalledWith({ consent_token: null, consent_token_expires_at: null });
	});
});
