import { describe, expect, it, vi } from "vitest";
import { TOOLS } from "./registry";
import { CUSTOMER_COLUMNS } from "@/lib/vendors/customers";
import { listCustomersOutput } from "./schemas";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

/**
 * Coverage and quality of the declared contracts.
 *
 * `defineTool` + the `BoundTool` brand already make a schema-less tool a
 * COMPILE error, so this is not about presence — it is about a schema being
 * worth having. `z.unknown()` satisfies the type and says nothing; so does an
 * empty object on a tool that plainly returns fields. Those pass the compiler
 * and fail here, which is why both gates exist.
 *
 * The third gate lives in dispatchTool, which validates every non-production
 * success. Between them, a wrong contract has to survive a compile error, a
 * shape check, and every existing handler test to reach a vendor.
 */

/** A schema that says something: named fields, a union of shapes, or a list. */
function isMeaningful(schema: unknown): boolean {
	const def = (schema as { _def?: { type?: string } })._def;
	const type = def?.type;
	return type === "object" || type === "union" || type === "array" || type === "enum";
}

describe("every tool declares a real contract", () => {
	it("has the tools this suite thinks it is checking", () => {
		// Without this, every it.each below would vacuously pass if TOOLS were
		// empty or failed to import — the failure that makes a suite green and
		// worthless.
		expect(TOOLS.length).toBe(21);
	});

	it.each(TOOLS.map((t) => [t.name, t] as const))("%s declares an output shape that says something", (_n, tool) => {
		expect(isMeaningful(tool.outputSchema)).toBe(true);
	});

	it.each(TOOLS.map((t) => [t.name, t] as const))("%s declares an input shape", (_n, tool) => {
		// An argument-less tool legitimately declares an empty object, so the
		// bar here is only that it declares a shape at all rather than `unknown`.
		expect(isMeaningful(tool.inputSchema)).toBe(true);
	});

	it("describes the fields a caller could not guess", () => {
		/*
		 * Reads `.description` off the schema rather than stringifying it. The
		 * first version of this JSON.stringify'd the Zod object and looked for
		 * the word — which found nothing, because descriptions do not survive
		 * that, and reported all 21 tools as undocumented. A test that fails
		 * uniformly is usually testing itself.
		 */
		const described = (schema: unknown): boolean => {
			const s = schema as {
				description?: string;
				shape?: Record<string, unknown>;
				options?: unknown[];
				element?: unknown;
				unwrap?: () => unknown;
			};
			if (s.description) return true;
			if (s.shape) return Object.values(s.shape).some(described);
			if (s.options) return s.options.some(described);
			// Arrays and nullables wrap the thing that carries the prose — most
			// of these tools describe fields inside a list, not the list itself.
			if (s.element) return described(s.element);
			if (typeof s.unwrap === "function") return described(s.unwrap());
			return false;
		};

		const undocumented = TOOLS.filter((t) => !described(t.outputSchema)).map((t) => t.name);

		// A tool whose entire payload is self-evident may stay silent, but it has
		// to be a short NAMED list rather than a default — these two return
		// { linked, slug, domain } and nothing about that needs explaining.
		expect(undocumented.sort()).toEqual(["create_vendor", "find_vendor_by_org"]);
	});

	/*
	 * The customer shape exists three times: CUSTOMER_COLUMNS (what is
	 * selected), CustomerRow (what TypeScript believes), and this schema (what
	 * callers are promised). columns.test.ts pins the first to the dashboard and
	 * knows nothing about the third.
	 *
	 * Only the ADD direction needs guarding here. A removed column already fails,
	 * because dispatchTool validates real payloads and a required field would go
	 * missing. An added one fails nothing — it just never appears in the
	 * contract. That is exactly how consent_sent_to went missing from the
	 * dashboard for weeks.
	 */
	it("declares every column a customer row actually carries", () => {
		const selected = CUSTOMER_COLUMNS.split(",").map((c) => c.trim());
		const shape = (listCustomersOutput as unknown as { shape: { customers: { element: { shape: object } } } }).shape;
		const declared = Object.keys(shape.customers.element.shape);

		for (const column of selected) {
			expect(declared, `CUSTOMER_COLUMNS selects "${column}" but no tool declares it`).toContain(column);
		}
	});
});
