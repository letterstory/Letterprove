import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * public/attest.js and public/visit.js, run in a sandbox with a fake page.
 * Both are plain ES5 shipped as-is, so this executes the real files rather
 * than copies. `scripts` runs several on ONE page, in order, to test the
 * dedupe between them (window.__lettervisit).
 */
const SOURCE = readFileSync(join(process.cwd(), "public/attest.js"), "utf8");
const VISIT_SOURCE = readFileSync(join(process.cwd(), "public/visit.js"), "utf8");
const SCRIPTS = {
	attest: { source: SOURCE, src: "https://app.letterprove.com/attest.js" },
	visit: { source: VISIT_SOURCE, src: "https://lettervisit.com/v.js" },
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

	it("sends the agent beacon only after the config says agent visitors is on", async () => {
		const on = run({ agent: true, modules: { proofs: true, agent_visitors: true, human_visitors: false } });
		await on.settle();
		expect(on.beacons.filter((b) => b.url.endsWith("/api/v1/agent-visit"))).toHaveLength(1);
		const off = run({ agent: true, modules: { proofs: true, agent_visitors: false, human_visitors: false } });
		await off.settle();
		expect(off.beacons.filter((b) => b.url.endsWith("/api/v1/agent-visit"))).toEqual([]);
	});

	it("keeps everything on for an older cached config without modules", async () => {
		const page = run({ stub: true, agent: true });
		await page.settle();
		expect(page.beacons.some((b) => b.url.endsWith("/api/v1/observe"))).toBe(true);
		expect(page.beacons.some((b) => b.url.endsWith("/api/v1/agent-visit"))).toBe(true);
	});
});

describe("attest.js and the Visitors script", () => {
	const agentVisits = (page: ReturnType<typeof run>) => page.beacons.filter((b) => b.url.endsWith("/api/v1/agent-visit"));
	const pixels = (page: ReturnType<typeof run>) => page.inserted.filter((el) => el.id === "__maverick__");

	it("attest.js asks for the config as s=attest, visit.js as s=visit through its own origin", async () => {
		const attest = run({ scripts: ["attest"] });
		const visit = run({ scripts: ["visit"] });
		await Promise.all([attest.settle(), visit.settle()]);
		expect(attest.configUrls).toEqual(["https://app.letterprove.com/api/v1/config?k=lp_live_x&s=attest"]);
		expect(visit.configUrls).toEqual(["https://lettervisit.com/api/v1/config?k=lp_live_x&s=visit"]);
	});

	it("visit.js sends the agent beacon through its own origin, and nothing for a person", async () => {
		const agent = run({ scripts: ["visit"], agent: true, modules: { proofs: true, agent_visitors: true, human_visitors: false } });
		await agent.settle();
		expect(agentVisits(agent)).toEqual([{ url: "https://lettervisit.com/api/v1/agent-visit", body: { k: "lp_live_x", path: "/", client: true, webdriver: false } }]);
		const person = run({ scripts: ["visit"], modules: { proofs: true, agent_visitors: true, human_visitors: false } });
		await person.settle();
		expect(person.beacons).toEqual([]);
	});

	it("visit.js sends no agent beacon when agent visitors is off, and keeps it on for a config without modules", async () => {
		const off = run({ scripts: ["visit"], agent: true, modules: { proofs: true, agent_visitors: false, human_visitors: false } });
		await off.settle();
		expect(agentVisits(off)).toEqual([]);
		const legacy = run({ scripts: ["visit"], agent: true });
		await legacy.settle();
		expect(agentVisits(legacy)).toHaveLength(1);
	});

	it("visit.js loads the pixel only when the config carries one, and never sends a sign-in", async () => {
		const on = run({ scripts: ["visit"], pixel: true, stub: true });
		await on.settle();
		expect(pixels(on)).toHaveLength(1);
		expect(on.beacons.filter((b) => b.url.endsWith("/api/v1/observe"))).toEqual([]);
		const off = run({ scripts: ["visit"] });
		await off.settle();
		expect(pixels(off)).toEqual([]);
	});

	it("visit.js sets window.__lettervisit before anything else, even for a bad key", async () => {
		const page = run({ scripts: ["visit"], configStatus: 404 });
		expect(page.window.__lettervisit).toBe(true);
	});

	it("legacy: attest.js alone still sends the agent beacon and loads the pixel", async () => {
		const page = run({ scripts: ["attest"], agent: true, pixel: true });
		await page.settle();
		expect(agentVisits(page)).toHaveLength(1);
		expect(pixels(page)).toHaveLength(1);
	});

	for (const order of [
		["attest", "visit"],
		["visit", "attest"],
	] as (keyof typeof SCRIPTS)[][]) {
		it(`both on one page (${order.join(" then ")}): one agent beacon, one pixel, sign-ins still from attest.js`, async () => {
			const page = run({ scripts: order, agent: true, pixel: true, stub: true });
			await page.settle();
			expect(agentVisits(page)).toHaveLength(1);
			expect(agentVisits(page)[0].url).toBe("https://lettervisit.com/api/v1/agent-visit");
			expect(pixels(page)).toHaveLength(1);
			expect(page.beacons.filter((b) => b.url.endsWith("/api/v1/observe")).map((b) => (b.body as { ev: string }).ev)).toEqual(["session", "login"]);
		});
	}
});
