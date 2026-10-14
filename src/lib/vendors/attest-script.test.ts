import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * public/attest.js, run in a sandbox with a fake page. Plain ES5 shipped
 * as-is, so this executes the real file rather than a copy. Attestation only
 * since 2026-10-14: no agent beacon, no pixel.
 */
const SOURCE = readFileSync(join(process.cwd(), "public/attest.js"), "utf8");
const SCRIPTS = {
	attest: { source: SOURCE, src: "https://app.letterprove.com/attest.js" },
};

const PIXEL = { customer_id: "1091", profile_id: "abcDEF123" };

function run({
	debug = false,
	stub = false,
	configStatus = 200,
	modules = undefined as Record<string, boolean> | undefined,
	agent = false,
	pixel = false,
	scripts = ["attest"] as (keyof typeof SCRIPTS)[],
} = {}) {
	const beacons: { url: string; body: unknown }[] = [];
	const logs: string[] = [];
	const configUrls: string[] = [];
	const inserted: { id: string; src: string }[] = [];
	const attrs: Record<string, string> = { "data-key": "lp_live_x" };
	if (debug) attrs["data-debug"] = "";
	const scriptEl = {
		src: SCRIPTS[scripts[0]].src,
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
			configUrls.push(url);
			const body = { cfg: 1, signals: [], ...(modules ? { modules } : {}), ...(pixel ? { visitors: { pixel: PIXEL } } : {}) };
			return { ok: configStatus === 200, status: configStatus, json: async () => body };
		}
		return { ok: true, status: 204 };
	});
	const navigator = {
		userAgent: agent ? "Mozilla/5.0 (compatible; GPTBot/1.2)" : "Mozilla/5.0 Chrome/130",
		webdriver: false,
		sendBeacon: (url: string, body: string) => {
			beacons.push({ url, body: JSON.parse(body) });
			return true;
		},
	};
	const head = {
		appendChild: (el: { id: string; src: string }) => inserted.push({ id: el.id, src: el.src }),
	};
	const document = {
		currentScript: scriptEl,
		head,
		getElementsByTagName: () => [scriptEl],
		getElementById: (id: string) => inserted.find((el) => el.id === id) ?? null,
		createElement: () => ({ setAttribute: () => {} }) as Record<string, unknown>,
	};
	const context = { window, document, navigator, fetch, location: window.location, URL, JSON, Math, Date, String };
	// The sandbox's global object is not `window`, so the scripts' `window.x` and a bare global differ; this keeps them one.
	(context as Record<string, unknown>).window = window;
	for (const name of scripts) {
		scriptEl.src = SCRIPTS[name].src;
		vm.runInNewContext(SCRIPTS[name].source, context);
	}
	return { window, beacons, logs, configUrls, inserted, settle: () => new Promise((r) => setTimeout(r, 0)) };
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

	it("sends no sign-ins when the proofs module is off", async () => {
		const page = run({ stub: true, modules: { proofs: false, agent_visitors: true, human_visitors: false } });
		await page.settle();
		expect(page.beacons.filter((b) => b.url.endsWith("/api/v1/observe"))).toEqual([]);
	});

	it("is attestation only: no agent beacon and no pixel, even for an agent with a pixel in the config", async () => {
		const page = run({ stub: true, agent: true, pixel: true, modules: { proofs: true, agent_visitors: true, human_visitors: true } });
		await page.settle();
		expect(page.beacons.some((b) => b.url.endsWith("/api/v1/agent-visit"))).toBe(false);
		expect(page.inserted).toEqual([]);
		expect(page.beacons.some((b) => b.url.endsWith("/api/v1/observe"))).toBe(true);
	});

	it("keeps collecting sign-ins for an older cached config without modules", async () => {
		const page = run({ stub: true });
		await page.settle();
		expect(page.beacons.some((b) => b.url.endsWith("/api/v1/observe"))).toBe(true);
	});

	it("asks for the config as s=attest", async () => {
		const page = run();
		await page.settle();
		expect(page.configUrls[0]).toContain("s=attest");
	});

	it("carries no visitor-identification or agent-visit code", () => {
		expect(SOURCE).not.toMatch(/maverick|agent-visit|__lettervisit|__letterAgentSent|pixel/i);
	});
});
