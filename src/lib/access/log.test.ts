import { describe, expect, it, vi } from "vitest";
import { logProofAccess } from "./log";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

const AI_AGENT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 GPTBot/1.0";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36";

function request(userAgent: string | null): Request {
	const headers = new Headers();
	if (userAgent) headers.set("user-agent", userAgent);
	return new Request("https://app.letterprove.com/api/proofs/vantage", { headers });
}

// The insert lands inside a fire-and-forget async IIFE — flush the
// microtask queue before asserting on it.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("logProofAccess", () => {
	it("never throws when no datastore is configured, even for an ai_agent hit", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		expect(() => logProofAccess(request(AI_AGENT_UA), "vantage")).not.toThrow();
		await flush();
	});

	it("records an ai_agent hit to agentic_read_events", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const insert = vi.fn().mockResolvedValue({ error: null });
		const from = vi.fn().mockReturnValue({ insert });
		vi.mocked(dbClient).mockReturnValue({ from } as never);

		logProofAccess(request(AI_AGENT_UA), "vantage/acme-corp");
		await flush();

		expect(from).toHaveBeenCalledWith("agentic_read_events");
		expect(insert).toHaveBeenCalledWith({
			vendor_slug: "vantage",
			subject: "vantage/acme-corp",
			agent_name: "chatgpt",
		});
	});

	it.each([
		["vantage", "vantage"],
		["vantage/acme-corp", "vantage"],
		["vantage/acme-corp/chain", "vantage"],
		["vantage/aggregate", "vantage"],
		["vantage/aggregate/chain", "vantage"],
	])("parses the vendor slug from subject %s as %s", async (subject, expectedVendor) => {
		const { dbClient } = await import("@/lib/db/client");
		const insert = vi.fn().mockResolvedValue({ error: null });
		vi.mocked(dbClient).mockReturnValue({ from: () => ({ insert }) } as never);

		logProofAccess(request(AI_AGENT_UA), subject);
		await flush();

		expect(insert).toHaveBeenCalledWith(expect.objectContaining({ vendor_slug: expectedVendor }));
	});

	it("does not record a browser hit", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const insert = vi.fn();
		vi.mocked(dbClient).mockReturnValue({ from: () => ({ insert }) } as never);

		logProofAccess(request(BROWSER_UA), "vantage");
		await flush();

		expect(insert).not.toHaveBeenCalled();
	});

	it("does not record an unknown/absent user-agent hit", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const insert = vi.fn();
		vi.mocked(dbClient).mockReturnValue({ from: () => ({ insert }) } as never);

		logProofAccess(request(null), "vantage");
		await flush();

		expect(insert).not.toHaveBeenCalled();
	});

	it("logs but never throws when the insert returns an error", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const insert = vi.fn().mockResolvedValue({ error: { message: "connection refused" } });
		vi.mocked(dbClient).mockReturnValue({ from: () => ({ insert }) } as never);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => logProofAccess(request(AI_AGENT_UA), "vantage")).not.toThrow();
		await flush();

		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("agentic read record failed"), "connection refused");
		consoleError.mockRestore();
	});

	it("logs but never throws when the insert rejects", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const insert = vi.fn().mockRejectedValue(new Error("socket hang up"));
		vi.mocked(dbClient).mockReturnValue({ from: () => ({ insert }) } as never);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => logProofAccess(request(AI_AGENT_UA), "vantage")).not.toThrow();
		await flush();

		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("agentic read record failed"), "socket hang up");
		consoleError.mockRestore();
	});
});
