import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATTEST_SCRIPT_PATH, installSnippet, originFromHeaders } from "./install";

describe("installSnippet", () => {
	it("points at the origin it was given, not a written-down host", () => {
		expect(installSnippet("https://app.letterprove.com", "lp_live_x")).toBe(
			'<script src="https://app.letterprove.com/attest.js" data-key="lp_live_x"></script>'
		);
	});

	// A vendor testing locally should get a snippet that works locally, rather
	// than one that silently posts to production under their local key.
	it("follows the deployment it is served from", () => {
		expect(installSnippet("http://localhost:9140", "lp_live_x")).toContain("http://localhost:9140/attest.js");
	});
});

describe("originFromHeaders", () => {
	// Behind Vercel's proxy `host` is an internal hostname. A snippet built from
	// it would point somewhere the vendor's visitors cannot reach.
	it("prefers the forwarded host over the internal one", () => {
		const h = new Headers({ host: "internal.vercel.internal", "x-forwarded-host": "app.letterprove.com", "x-forwarded-proto": "https" });
		expect(originFromHeaders(h)).toBe("https://app.letterprove.com");
	});

	it("falls back to host for a local next start, where nothing forwards", () => {
		expect(originFromHeaders(new Headers({ host: "localhost:9140" }))).toBe("http://localhost:9140");
	});

	it("assumes https for a real hostname with no forwarded proto", () => {
		expect(originFromHeaders(new Headers({ host: "app.letterprove.com" }))).toBe("https://app.letterprove.com");
	});

	it("returns null rather than inventing an origin", () => {
		expect(originFromHeaders(new Headers())).toBeNull();
	});
});

/**
 * The guard that actually matters. The bug was not a broken function — it was a
 * correct-looking string in a page nobody re-read, naming a host that has never
 * resolved. attest.js is `public/attest.js`, so it is only ever served by this
 * app at this app's own origin; any absolute host in the repo is a claim about
 * infrastructure that has to exist, and cdn.letterprove.com did not.
 *
 * Scoped to attest.js references specifically, so it fails on the mistake
 * rather than on every URL anyone ever writes down.
 */
describe("no source file names a host for attest.js that we do not serve", () => {
	const ROOTS = ["src", "README.md"];
	const SERVED_BY_US = /^https:\/\/(app\.)?letterprove\.com$/;

	function walk(path: string): string[] {
		if (statSync(path).isFile()) return path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".md") ? [path] : [];
		return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
	}

	it("only ever points at an origin this app actually serves", () => {
		const offenders: string[] = [];

		for (const file of ROOTS.flatMap((r) => walk(r))) {
			// The helper and this test are where the rule is written down.
			if (file.includes("vendors/install")) continue;

			for (const [, origin] of readFileSync(file, "utf8").matchAll(
				new RegExp(`(https?://[^"'\`\\s)]+)${ATTEST_SCRIPT_PATH}`, "g")
			)) {
				if (!SERVED_BY_US.test(origin)) offenders.push(`${file}: ${origin}${ATTEST_SCRIPT_PATH}`);
			}
		}

		expect(offenders).toEqual([]);
	});
});
