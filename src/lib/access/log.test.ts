import { describe, expect, it, vi } from "vitest";
import { logProofAccess } from "./log";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
const verified = vi.hoisted(() => ({ value: true, seen: [] as unknown[] }));
vi.mock("./verify-agent", () => ({
	clientIp: (h: Headers) => h.get("x-real-ip"),
	isVerifiedAgent: async (...args: unknown[]) => {
		verified.seen.push(args);
		return verified.value;
	},
}));

const AI_AGENT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 GPTBot/1.0";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36";

function request(userAgent: string | null, ip = "203.0.113.9"): Request {
	const headers = new Headers({ "x-real-ip": ip });
	if (userAgent) headers.set("user-agent", userAgent);
	return new Request("https://app.letterprove.com/api/proofs/vantage", { headers });
}

// Outside a request scope the insert runs inline but asynchronously (it awaits
// verification first) — flush before asserting on it.
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
			verified: true,
		});
		// Verified against the claimed operator, from the request's own address.
		expect(verified.seen.at(-1)).toEqual(["chatgpt", "203.0.113.9"]);
	});

	it("records a spoofed agent claim as unverified — kept as evidence, never billed", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const insert = vi.fn().mockResolvedValue({ error: null });
		vi.mocked(dbClient).mockReturnValue({ from: () => ({ insert }) } as never);
		verified.value = false;

		logProofAccess(request(AI_AGENT_UA, "198.51.100.7"), "vantage");
		await flush();
		verified.value = true;

		expect(insert).toHaveBeenCalledWith(expect.objectContaining({ agent_name: "chatgpt", verified: false }));
		// The address is used to verify and dropped: it is never written.
		expect(JSON.stringify(insert.mock.calls)).not.toContain("198.51.100.7");
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
