import { describe, expect, it, vi } from "vitest";
import { isOriginAccepted } from "./hosts";
import { installRecipes } from "./install";
import { classifyRejected } from "@/lib/telemetry/rejected-origins";
import { noticeFor, renderNotice, type NoticeKind } from "@/lib/notify/vendor-email";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

describe("isOriginAccepted", () => {
	const none = new Set<string>();
	it("accepts the verified domain and every host beneath it", () => {
		for (const o of ["acme.com", "www.acme.com", "app.acme.com", "eu.app.acme.com"]) expect(isOriginAccepted(o, "acme.com", none)).toBe(true);
	});
	it("does not accept a sibling or parent of a verified subdomain unless it was added", () => {
		expect(isOriginAccepted("www.acme.com", "app.acme.com", none)).toBe(false);
		expect(isOriginAccepted("acme.com", "app.acme.com", none)).toBe(false);
		expect(isOriginAccepted("www.acme.com", "app.acme.com", new Set(["www.acme.com"]))).toBe(true);
	});
	it("never accepts a lookalike", () => {
		expect(isOriginAccepted("evilacme.com", "acme.com", none)).toBe(false);
		expect(isOriginAccepted("acme.com.evil.io", "acme.com", none)).toBe(false);
	});
});

describe("classifyRejected", () => {
	it("calls local and preview hosts development, never addable", () => {
		for (const h of ["localhost", "127.0.0.1", "acme-git-main.vercel.app"]) expect(classifyRejected(h, "acme.com")).toEqual({ addable: false, reason: "development" });
	});
	it("offers a sibling on the same registrable domain", () => {
		expect(classifyRejected("www.acme.com", "app.acme.com")).toEqual({ addable: true, reason: "needs_proof" });
	});
	it("refuses another company's domain", () => {
		expect(classifyRejected("acme.io", "acme.com")).toEqual({ addable: false, reason: "other_company" });
	});
});

describe("install recipes", () => {
	const recipes = installRecipes("https://app.letterprove.com", "lp_live_acme");
	it("covers every stack, each calling identify or login with the user's email", () => {
		expect(Object.keys(recipes).sort()).toEqual(["auth0", "clerk", "nextjs", "plain_js", "stub", "supabase"]);
		for (const [name, code] of Object.entries(recipes)) {
			if (name === "stub") continue;
			expect(code, name).toMatch(/Letterprove(\?)?\.(identify|login)\(/);
		}
	});
	it("points at this origin with this key, and keeps early calls with the stub", () => {
		expect(recipes.stub).toContain('src="https://app.letterprove.com/attest.js" data-key="lp_live_acme"');
		expect(recipes.stub).toContain("q:[]");
	});

});

describe("incident emails", () => {
	const kinds: NoticeKind[] = ["dns_lost", "collection_quiet", "stripe_failing", "posthog_failing"];
	it("speak product language, never internal tool names, and link the dashboard", () => {
		for (const kind of kinds) {
			const notice = noticeFor(kind, { vendorName: "Acme", domain: "acme.com", detail: "key revoked" });
			const { text, html } = renderNotice(notice);
			expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
			expect(text).toContain("https://app.letterstory.com/proofs");
			expect(html).toContain("https://app.letterstory.com/proofs");
		}
	});
	it("escapes what it quotes", () => {
		const { html } = renderNotice(noticeFor("stripe_failing", { vendorName: "<b>Acme</b>", domain: "acme.com", detail: "<script>" }));
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<b>Acme</b>");
	});
});
