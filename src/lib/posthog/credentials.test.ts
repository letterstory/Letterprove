import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyKey, decryptPosthogKey, encryptPosthogKey, normalizeApiHost, saveCredential } from "./credentials";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

const KEY = "LETTERPROVE_POSTHOG_ENCRYPTION_KEY";
const original = process.env[KEY];
beforeEach(() => {
	process.env[KEY] = "test-encryption-secret";
});
afterEach(() => {
	if (original === undefined) delete process.env[KEY];
	else process.env[KEY] = original;
});

describe("classifyKey", () => {
	it("accepts a personal API key", () => {
		expect(classifyKey(" phx_abcdefghijklmnopqrstuvwxyz1234 ")).toEqual({
			ok: true,
			key: "phx_abcdefghijklmnopqrstuvwxyz1234",
			last4: "1234",
		});
	});
	it("refuses a public project key, which can only send events", () => {
		expect(classifyKey("phc_abcdefghijklmnopqrstuvwxyz")).toEqual({ ok: false, reason: "project_key" });
	});
	it("refuses anything else", () => {
		for (const bad of ["", "phx_short", "rk_live_abc", "hello"]) expect(classifyKey(bad)).toEqual({ ok: false, reason: "malformed" });
	});
});

describe("normalizeApiHost", () => {
	it("defaults to US cloud", () => expect(normalizeApiHost(undefined)).toBe("https://us.posthog.com"));
	it("maps ingestion hosts to the API host", () => {
		expect(normalizeApiHost("https://us.i.posthog.com")).toBe("https://us.posthog.com");
		expect(normalizeApiHost("eu.i.posthog.com")).toBe("https://eu.posthog.com");
	});
	it("accepts a self-hosted https host", () => expect(normalizeApiHost("posthog.acme.com")).toBe("https://posthog.acme.com"));
	it("refuses http, IPs, ports, credentials and local names", () => {
		for (const bad of ["http://posthog.acme.com", "https://10.0.0.1", "https://posthog.acme.com:8443", "https://a:b@posthog.acme.com", "localhost", "https://ph.internal"]) {
			expect(normalizeApiHost(bad)).toBeNull();
		}
	});
});

describe("encryption", () => {
	it("round-trips and never stores the plaintext", () => {
		const sealed = encryptPosthogKey("phx_secret");
		expect(sealed).not.toContain("phx_secret");
		expect(decryptPosthogKey(sealed)).toBe("phx_secret");
	});
	it("refuses to store anything when no encryption key is configured", async () => {
		delete process.env[KEY];
		const saved = await saveCredential("v1", "phx_abcdefghijklmnopqrstuvwxyz1234", { apiHost: "https://us.posthog.com", projectId: "1" });
		expect(saved).toEqual({ ok: false, reason: "not_configured" });
	});
});
