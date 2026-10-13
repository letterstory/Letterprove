import { describe, expect, it, vi } from "vitest";
import { HISTORY_QUERY, ACTIVITY_QUERY, hogql, hostEventsQuery, parseActivity, parseHistory } from "./fetch";

const target = { key: "phx_k", apiHost: "https://us.posthog.com", projectId: "42" };
const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("hogql", () => {
	it("posts a HogQL query to the project and returns rows", async () => {
		const fetcher = respond(200, { results: [[1]] });
		expect(await hogql(target, "SELECT 1", fetcher)).toEqual({ ok: true, rows: [[1]] });
		const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(url).toBe("https://us.posthog.com/api/projects/42/query/");
		expect(JSON.parse(init.body)).toEqual({ query: { kind: "HogQLQuery", query: "SELECT 1" } });
	});
	it("names an auth failure as one", async () => {
		expect(await hogql(target, "SELECT 1", respond(401, {}))).toMatchObject({ ok: false, auth: true });
		expect(await hogql(target, "SELECT 1", respond(403, {}))).toMatchObject({ ok: false, auth: true });
	});
	it("relays PostHog's message on other failures", async () => {
		expect(await hogql(target, "SELECT 1", respond(400, { detail: "bad query" }))).toMatchObject({ ok: false, auth: false, error: "bad query" });
	});
});

describe("queries", () => {
	it("split the address inside PostHog, so no address is ever returned", () => {
		for (const q of [HISTORY_QUERY, ACTIVITY_QUERY]) {
			expect(q).toMatch(/splitByChar\('@'/);
			expect(q).not.toMatch(/SELECT\s+(person\.)?properties\.email/i);
		}
	});
	it("match the vendor's hosts and their subdomains, and drop anything unsafe", () => {
		const q = hostEventsQuery(["acme.com", "x'; DROP", "acme.io"]);
		expect(q).toContain("host = 'acme.com' OR endsWith(host, '.acme.com')");
		expect(q).toContain("'acme.io'");
		expect(q).not.toContain("DROP");
		expect(hostEventsQuery([])).toBe("SELECT 0");
	});
});

describe("parsing", () => {
	it("keeps rows whose domain normalizes", () => {
		expect(parseHistory([["Acme.com", "2024-01-02T00:00:00Z", 3], ["", null, 1], [null, null, 1]])).toEqual([
			{ domain: "acme.com", firstSeen: "2024-01-02T00:00:00.000Z", people: 3 },
		]);
		expect(parseActivity([["acme.com", "2", "5", "2026-10-01 10:00:00"]])).toEqual([
			{ domain: "acme.com", people: 2, sessions: 5, lastSeen: expect.any(String) },
		]);
	});
});
