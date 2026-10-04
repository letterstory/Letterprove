import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetRangeCache, clientIp, isVerifiedAgent, parseIp } from "./verify-agent";

function serve(lists: Record<string, unknown>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) =>
			url in lists
				? new Response(JSON.stringify(lists[url]), { status: 200 })
				: new Response("nope", { status: 404 })
		)
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	_resetRangeCache();
});

const OPENAI = {
	"https://openai.com/gptbot.json": { prefixes: [{ ipv4Prefix: "20.171.206.0/24" }] },
	"https://openai.com/searchbot.json": { prefixes: [{ ipv4Prefix: "52.255.111.48/28" }] },
	"https://openai.com/chatgpt-user.json": { prefixes: [{ ipv6Prefix: "2a03:2880:f000::/36" }] },
};

describe("isVerifiedAgent", () => {
	it("verifies a claim only from the claimed operator's published ranges", async () => {
		serve(OPENAI);
		expect(await isVerifiedAgent("chatgpt", "20.171.206.44")).toBe(true);
		expect(await isVerifiedAgent("chatgpt", "52.255.111.60")).toBe(true);
		expect(await isVerifiedAgent("chatgpt", "52.255.111.64")).toBe(false); // just outside the /28
		expect(await isVerifiedAgent("chatgpt", "198.51.100.7")).toBe(false); // a spoofer's laptop
	});

	it("matches IPv6 ranges, and IPv4-mapped IPv6 as the IPv4 it carries", async () => {
		serve(OPENAI);
		expect(await isVerifiedAgent("chatgpt", "2a03:2880:f00a::1")).toBe(true);
		expect(await isVerifiedAgent("chatgpt", "2a03:2881::1")).toBe(false);
		expect(await isVerifiedAgent("chatgpt", "::ffff:20.171.206.1")).toBe(true);
	});

	it("never verifies an agent whose operator publishes nothing", async () => {
		serve(OPENAI);
		expect(await isVerifiedAgent("meta", "20.171.206.44")).toBe(false);
	});

	it("does not let one operator's ranges vouch for another's agent", async () => {
		serve({ ...OPENAI, "https://claude.com/crawling/bots.json": { prefixes: [{ ipv4Prefix: "216.73.216.0/22" }] } });
		expect(await isVerifiedAgent("claude", "20.171.206.44")).toBe(false);
		expect(await isVerifiedAgent("claude", "216.73.217.5")).toBe(true);
	});

	it("fails closed when a list cannot be fetched — undercharging, never overcharging", async () => {
		serve({});
		expect(await isVerifiedAgent("chatgpt", "20.171.206.44")).toBe(false);
	});

	it("keeps a stale list rather than dropping to nothing on a later fetch failure", async () => {
		serve(OPENAI);
		expect(await isVerifiedAgent("chatgpt", "20.171.206.44")).toBe(true);
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000);
		serve({});
		expect(await isVerifiedAgent("chatgpt", "20.171.206.44")).toBe(true);
		vi.useRealTimers();
	});

	it("is false without an address", async () => {
		serve(OPENAI);
		expect(await isVerifiedAgent("chatgpt", null)).toBe(false);
		expect(await isVerifiedAgent("chatgpt", "not-an-ip")).toBe(false);
	});
});

describe("parseIp", () => {
	it("rejects malformed addresses", () => {
		for (const bad of ["256.1.1.1", "1.2.3", "1::2::3", "12345::1", "g::1", ""]) expect(parseIp(bad)).toBeNull();
	});
	it("expands compressed IPv6", () => {
		expect(parseIp("::1")).toEqual({ v6: true, value: 1n });
	});
});

describe("clientIp", () => {
	it("prefers Vercel's own header and takes the first hop", () => {
		expect(clientIp(new Headers({ "x-vercel-forwarded-for": "20.171.206.44", "x-forwarded-for": "1.1.1.1" }))).toBe(
			"20.171.206.44"
		);
		expect(clientIp(new Headers({ "x-forwarded-for": "20.171.206.44, 10.0.0.1" }))).toBe("20.171.206.44");
		expect(clientIp(new Headers())).toBeNull();
	});
});
