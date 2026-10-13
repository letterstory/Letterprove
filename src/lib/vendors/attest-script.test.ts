import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * public/attest.js, run in a sandbox with a fake page. It is plain ES5 shipped
 * as-is, so this executes the real file rather than a copy.
 */
const SOURCE = readFileSync(join(process.cwd(), "public/attest.js"), "utf8");

function run({ debug = false, stub = false, configStatus = 200 } = {}) {
	const beacons: { url: string; body: unknown }[] = [];
	const logs: string[] = [];
	const attrs: Record<string, string> = { "data-key": "lp_live_x" };
	if (debug) attrs["data-debug"] = "";
	const scriptEl = {
		src: "https://app.letterprove.com/attest.js",
		getAttribute: (n: string) => attrs[n] ?? null,
		hasAttribute: (n: string) => n in attrs,
	};
	const window: Record<string, unknown> = {
		location: { hostname: "app.acme.com", pathname: "/" },
		console: { info: (m: string) => logs.push(`info ${m}`), warn: (m: string) => logs.push(`warn ${m}`) },
	};
	if (stub) {
		// The documented one-line stub, called before the script loads.
		vm.runInNewContext(
			"window.Letterprove=window.Letterprove||{q:[],identify:function(e){this.q.push(['identify',e])},login:function(e){this.q.push(['login',e])},signup:function(e){this.q.push(['signup',e])}};window.Letterprove.login('ana@globex.com');",
			{ window },
		);
	}
	const fetch = vi.fn(async (url: string) => {
		if (url.includes("/api/v1/config")) {
			return { ok: configStatus === 200, status: configStatus, json: async () => ({ cfg: 1, signals: [] }) };
		}
		return { ok: true, status: 204 };
	});
	const navigator = {
		userAgent: "Mozilla/5.0 Chrome/130",
		webdriver: false,
		sendBeacon: (url: string, body: string) => {
			beacons.push({ url, body: JSON.parse(body) });
			return true;
		},
	};
	const document = { currentScript: scriptEl, getElementsByTagName: () => [scriptEl], getElementById: () => null };
	const context = { window, document, navigator, fetch, location: window.location, URL, JSON, Math, Date, String };
	vm.runInNewContext(SOURCE, context);
	return { window, beacons, logs, settle: () => new Promise((r) => setTimeout(r, 0)) };
}

describe("attest.js", () => {
	it("runs calls the page queued through the stub before the script loaded", async () => {
		const page = run({ stub: true });
		await page.settle();
		const events = page.beacons.filter((b) => b.url.endsWith("/api/v1/observe")).map((b) => b.body as { ev: string; domain: string });
		expect(events.map((e) => e.ev)).toEqual(["session", "login"]);
		expect(events.every((e) => e.domain === "globex.com")).toBe(true);
		expect((page.window.Letterprove as { q: unknown[] }).q).toEqual([]);
	});

	it("is silent without data-debug", async () => {
		const page = run({ stub: true });
		await page.settle();
		expect(page.logs).toEqual([]);
	});

	it("explains itself in the console with data-debug, domain only", async () => {
		const page = run({ debug: true, stub: true });
		await page.settle();
		const text = page.logs.join("\n");
		expect(text).toContain("loaded on app.acme.com");
		expect(text).toContain("identified a user at globex.com");
		expect(text).toContain("sent login for globex.com");
		expect(text).not.toContain("ana@");
	});

	it("warns, with data-debug, when the key isn't recognised", async () => {
		const page = run({ debug: true, configStatus: 404 });
		await page.settle();
		expect(page.logs.some((l) => l.startsWith("warn") && l.includes("isn't recognised"))).toBe(true);
	});
});
