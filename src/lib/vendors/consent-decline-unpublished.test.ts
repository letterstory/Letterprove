import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A decline is recorded for the vendor's own audit trail and for dispute
 * resolution. It is never published.
 *
 * The reasoning is the same one that keeps `countersigned_by` out of every
 * attestation, only stronger: a customer who APPROVED at least consented to
 * being named, and we still don't publish which person clicked. A customer who
 * DECLINED consented to nothing whatsoever — including to the fact of their
 * refusal being public. "Globex was asked and said no" is a fact about a real
 * company's relationship with a vendor, and publishing it would be a small
 * betrayal committed by the one product that exists to make consent legible.
 *
 * Today this holds structurally: the publish path reads through
 * `vendorFromRow`/`allVendors` in lib/fixtures/vendors.ts, whose SELECT lists
 * are explicit and don't mention the decline columns. That is a property of
 * two string literals, which is exactly the kind of thing that stays true by
 * accident until someone widens a select to `*` or adds a field "for
 * completeness". These assertions make widening it fail here, next to the
 * reason, rather than silently in production.
 */

const FIXTURES = "src/lib/fixtures/vendors.ts";
const DECLINE_COLUMNS = ["consent_declined_at", "consent_decline_count"];

describe("a decline never reaches the published surface", () => {
	it("the fixture loader — everything published is built from it — never selects the decline columns", () => {
		const source = readFileSync(`${process.cwd()}/${FIXTURES}`, "utf8");

		for (const column of DECLINE_COLUMNS) {
			expect(source, `${FIXTURES} mentions ${column}; the publish path must not carry it`).not.toContain(column);
		}
	});

	it("the fixture loader selects an explicit column list rather than *", () => {
		const source = readFileSync(`${process.cwd()}/${FIXTURES}`, "utf8");

		// `select("*")` on vendor_customers would pull the decline columns into
		// the fixture in one edit and defeat the check above without ever naming
		// them. The publish path has to keep listing what it wants.
		expect(source).not.toMatch(/\.select\(\s*["'`]\*/);
	});

	it("the attestation body type has no decline field", () => {
		const types = readFileSync(`${process.cwd()}/src/lib/attest/types.ts`, "utf8");

		// Catches the other direction: someone adding `declined` to the published
		// schema directly, without going through the fixture loader at all.
		expect(types).not.toMatch(/declin/i);
	});

	/*
	 * The columns must exist somewhere, or the first two assertions would also
	 * pass against a branch where the feature was reverted — proving nothing.
	 */
	it("but the columns do exist on the row the vendor's own dashboard reads", () => {
		const customers = readFileSync(`${process.cwd()}/src/lib/vendors/customers.ts`, "utf8");

		for (const column of DECLINE_COLUMNS) {
			expect(customers).toContain(column);
		}
	});
});
