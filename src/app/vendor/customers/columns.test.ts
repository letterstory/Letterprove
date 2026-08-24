import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTOMER_COLUMNS } from "@/lib/vendors/customers";

/**
 * Guards the drift that shipped a half-working feature to production.
 *
 * `consent_sent_to` was added to the schema, to CUSTOMER_COLUMNS, and to the
 * UI's CustomerRow — but the customers page carried its own hand-written
 * `.select(...)` listing the older set. Every row therefore reached the
 * component with the field `undefined`, so the button could never read
 * "Resend request" and a vendor had no way to see a consent request was
 * already outstanding. Types didn't catch it: the select string is just a
 * string, and the result was cast to CustomerRow.
 *
 * Two assertions, because the failure has two directions.
 */
describe("customer column plumbing", () => {
	const dir = join(process.cwd(), "src/app/vendor/customers");
	const page = readFileSync(join(dir, "page.tsx"), "utf8");
	const manager = readFileSync(join(dir, "CustomersManager.tsx"), "utf8");

	it("the page does not hand-write its own vendor_customers select", () => {
		// Reading through listCustomers() is what makes the column list single-
		// sourced. A local select here is the bug re-appearing, whatever columns
		// it happens to name today.
		expect(page).toContain("listCustomers(");
		expect(page).not.toMatch(/\.from\(\s*["'`]vendor_customers["'`]\s*\)/);
	});

	it("every field the UI reads is actually selected", () => {
		const selected = new Set(CUSTOMER_COLUMNS.split(",").map((c) => c.trim()));

		// The interface block at the top of CustomersManager.tsx is the UI's
		// contract for a row; each of its snake_case fields has to be fetched.
		const body = manager.slice(manager.indexOf("CustomerRow"), manager.indexOf("interface Props"));
		const declared = [...body.matchAll(/^\t([a-z_]+)\??:/gm)].map((m) => m[1]);

		expect(declared.length).toBeGreaterThan(5);
		for (const field of declared) {
			expect(selected.has(field), `CustomersManager reads "${field}" but CUSTOMER_COLUMNS doesn't select it`).toBe(
				true,
			);
		}
	});
});
