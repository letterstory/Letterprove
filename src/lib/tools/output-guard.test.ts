import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ dbClient: () => null }));
vi.mock("@/lib/vendors/status", () => ({
	getVendorStatus: vi.fn(async () => ({
		ok: true,
		receiving: true,
		installed: true,
		count: 3,
		publishedAt: "2026-01-01T00:00:00.000Z",
	})),
}));

/**
 * The property the whole design rests on: loud in CI, absent in production.
 *
 * If that exemption ever stopped working, a wrong SCHEMA would take down a
 * working vendor CALL — turning a documentation bug into an outage, which is
 * strictly worse than the problem the validation exists to catch. It is one
 * condition guarding a throw, which is exactly the kind of code that looks
 * obviously correct and is worth proving anyway.
 */

const principal = {
	tokenId: "letterstory-service",
	vendorId: "v1",
	userId: "u1",
	capabilities: ["vendor:read"],
	orgId: "o1",
} as never;

async function withImpossibleSchema() {
	const { TOOLS, dispatchTool } = await import("./registry");
	const { z } = await import("zod");
	const tool = TOOLS.find((t) => t.name === "get_status")!;
	const original = tool.outputSchema;
	(tool as { outputSchema: unknown }).outputSchema = z.object({ impossible: z.string() });
	return { dispatchTool, restore: () => ((tool as { outputSchema: unknown }).outputSchema = original) };
}

afterEach(() => vi.unstubAllEnvs());

describe("the output guard", () => {
	it("throws outside production, so a drifted contract fails in CI", async () => {
		const { dispatchTool, restore } = await withImpossibleSchema();
		await expect(dispatchTool("get_status", {}, principal)).rejects.toThrow(/outputSchema rejects/);
		restore();
	});

	it("never throws in production — a wrong schema must not break a working call", async () => {
		const { dispatchTool, restore } = await withImpossibleSchema();
		vi.stubEnv("NODE_ENV", "production");

		const outcome = await dispatchTool("get_status", {}, principal);

		// The real payload, served intact, despite a schema that rejects it.
		expect(outcome).toEqual({
			kind: "result",
			result: {
				ok: true,
				body: {
					receiving: true,
					installed: true,
					count: 3,
					published: true,
					published_at: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		restore();
	});
});
