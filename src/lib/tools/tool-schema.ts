import { z } from "zod";

/**
 * Deriving a tool's advertised JSON Schema from the Zod schema its handler
 * actually uses.
 *
 * Ported deliberately from Letterstory's `src/lib/mcp/tool-schema.ts` (Steve's
 * #1129/#1130/#1160) rather than invented here. These two services are meant to
 * describe their tools the same way — a vendor reading `GET /api/v1/tools` and
 * an agent reading Letterstory's `tools/list` should not have to learn two
 * conventions for the same idea. Keeping the projection rules identical is what
 * makes that true, so the differences below are only the ones this codebase
 * forces, and there are none today.
 *
 * The problem it solves here is slightly worse than the one it solved there.
 * Letterprove's tools never advertised their arguments as a schema at all: the
 * shape lived in prose inside each tool's `description` ("Args: slug, name,
 * domain, since, consent?") while the handler validated with hand-rolled
 * `typeof` checks. Prose cannot be validated against, so those two drifted
 * silently and a caller had no machine-readable contract for either half.
 */

/**
 * The *request* shape.
 *
 * `io: "input"` means a field with `.default()` or `.optional()` is advertised
 * as optional rather than required — the caller may omit it.
 *
 * `$schema` is stripped because no consumer here reads the dialect marker.
 *
 * The root object is closed with `additionalProperties: false`. A tool's input
 * is a closed contract: an unrecognised argument is far more likely to be a
 * caller's typo (`{ dommain }`) that would otherwise be silently dropped than
 * it is to be forward compatibility. Saying so in the schema lets a caller find
 * that themselves.
 */
export function toInputSchema(schema: z.ZodType): Record<string, unknown> {
	const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
	delete json.$schema;
	if (json.type === "object" && json.additionalProperties === undefined) {
		json.additionalProperties = false;
	}
	return json;
}

/** What a tool taking no arguments advertises. */
export const EMPTY_INPUT_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

/**
 * The *response* shape — the mirror of `toInputSchema`, and the seam every
 * surface that documents a return value projects through, so no surface keeps
 * a second hand-maintained copy.
 *
 * `io: "output"` inverts the treatment of defaults: a field with a `.default()`
 * is always present in a response, so it is advertised as required — the
 * opposite of the input projection.
 *
 * Unlike inputs, the object is left **open**. A response contract is a lower
 * bound: "these fields will be present." Closing it would make every future
 * additive field a breaking change to the advertised schema, which is a strong
 * reason for nobody to ever add one.
 *
 * That openness has to be applied, not assumed. Zod 4 emits
 * `additionalProperties: false` in OUTPUT mode and omits it in INPUT mode —
 * the exact inverse of what you'd expect, and of what this pair of functions
 * wants. So inputs must add the closure Zod withholds, and outputs must strip
 * the closure Zod imposes. Measured, not assumed:
 *
 *   z.toJSONSchema(z.object({a: z.string()}), { io: "output" })
 *     → { ..., additionalProperties: false }
 *   z.toJSONSchema(z.object({a: z.string()}), { io: "input" })
 *     → { ... }                                    // no additionalProperties
 *
 * ⚠️ Letterstory's src/lib/mcp/tool-schema.ts carries this same comment and
 * does NOT strip it, so its advertised output schemas are closed against their
 * stated intent — every additive field there is a breaking schema change today.
 * Worth raising rather than silently diverging.
 */
export function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
	const json = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
	delete json.$schema;
	delete json.additionalProperties;
	return json;
}
