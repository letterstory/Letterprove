import { describe, expect, it } from "vitest";
import { TOOLS } from "./registry";
import { toInputSchema, toOutputSchema } from "./tool-schema";

/**
 * Coverage and quality of the advertised tool contracts.
 *
 * `defineTool` + the `BoundTool` brand already make a schema-less tool a
 * COMPILE error, so this file is not about presence — it is about a schema
 * being worth having. `z.unknown()` satisfies the type and documents nothing;
 * so does an empty object on a tool that plainly returns fields. Those pass the
 * compiler and fail here, which is the whole point of having both gates.
 *
 * The other half of the enforcement lives in dispatchTool, which validates
 * every non-production success against its tool's outputSchema — so
 * registry.test.ts's ~50 cases are conformance tests too. Between the three,
 * a wrong contract has to survive a compile error, a projection check, and
 * every existing handler test to reach a vendor.
 */

/** A schema that says something: named fields, a union of shapes, or a list. */
function isMeaningful(json: Record<string, unknown>): boolean {
	return (
		json.properties !== undefined ||
		json.anyOf !== undefined ||
		json.oneOf !== undefined ||
		json.type === "array" ||
		json.enum !== undefined
	);
}

describe("every tool advertises a real contract", () => {
	it("has tools to check", () => {
		// Without this, every it.each below would vacuously pass if TOOLS were
		// ever empty or failed to import — the failure mode that makes a whole
		// suite green and worthless.
		expect(TOOLS.length).toBe(15);
	});

	it.each(TOOLS.map((t) => [t.name, t] as const))("%s projects an output schema that documents something", (_name, tool) => {
		const json = toOutputSchema(tool.outputSchema);
		expect(isMeaningful(json)).toBe(true);
	});

	it.each(TOOLS.map((t) => [t.name, t] as const))("%s projects an input schema", (_name, tool) => {
		const json = toInputSchema(tool.inputSchema);

		// An argument-less tool legitimately projects `{}` properties, so the
		// meaningful-ness bar that applies to outputs would be wrong here.
		// What must hold is that it projects a closed object at all.
		expect(json.type).toBe("object");
		expect(json.additionalProperties).toBe(false);
	});

	/*
	 * Inputs are closed and outputs are open, deliberately and in opposite
	 * directions — see tool-schema.ts. Asserting it here means the reasoning
	 * survives someone "tidying up" the asymmetry into consistency.
	 */
	it("closes inputs but leaves outputs open", () => {
		for (const tool of TOOLS) {
			expect(toInputSchema(tool.inputSchema).additionalProperties, `${tool.name} input`).toBe(false);
			expect(toOutputSchema(tool.outputSchema).additionalProperties, `${tool.name} output`).toBeUndefined();
		}
	});

	it("describes the fields a caller could not guess", () => {
		// Not every field needs prose — `name: string` explains itself. But a
		// contract with no descriptions anywhere is a shape, not documentation,
		// and the point of this work was to stop making callers read source.
		const undocumented = TOOLS.filter((tool) => {
			const json = JSON.stringify(toOutputSchema(tool.outputSchema));
			return !json.includes("description");
		}).map((t) => t.name);

		expect(undocumented).toEqual([]);
	});
});
