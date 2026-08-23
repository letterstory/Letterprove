import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	classifyKey,
	encryptStripeKey,
	decryptStripeKey,
	saveCredential,
	stripeEncryptionConfigured,
} from "./credentials";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

const KEY = "LETTERPROVE_STRIPE_ENCRYPTION_KEY";
const original = process.env[KEY];

beforeEach(() => {
	process.env[KEY] = "test-encryption-secret";
	vi.clearAllMocks();
});
afterEach(() => {
	if (original === undefined) delete process.env[KEY];
	else process.env[KEY] = original;
});

describe("classifyKey", () => {
	it("accepts a restricted test key and reads its mode", () => {
		expect(classifyKey("rk_test_abc123XYZ")).toEqual({
			ok: true,
			key: "rk_test_abc123XYZ",
			livemode: false,
			last4: "3XYZ",
		});
	});

	it("accepts a restricted live key", () => {
		expect(classifyKey("rk_live_abc123XYZ")).toMatchObject({ ok: true, livemode: true });
	});

	it("REFUSES an unrestricted secret key", () => {
		// sk_ can do anything to the account, including refunding a vendor's
		// customers. Publishing proof never needs that, so it is refused with a
		// reason rather than quietly accepted.
		expect(classifyKey("sk_live_abc123")).toEqual({ ok: false, reason: "unrestricted" });
		expect(classifyKey("sk_test_abc123")).toEqual({ ok: false, reason: "unrestricted" });
	});

	it("refuses a publishable key, which cannot read subscriptions at all", () => {
		expect(classifyKey("pk_live_abc123")).toEqual({ ok: false, reason: "publishable" });
	});

	it("refuses anything else", () => {
		for (const bad of ["", "hello", "rk_", "rk_staging_abc", "whsec_abc"]) {
			expect(classifyKey(bad)).toEqual({ ok: false, reason: "malformed" });
		}
	});

	it("trims surrounding whitespace from a pasted key", () => {
		expect(classifyKey("  rk_test_abc123  ")).toMatchObject({ ok: true, key: "rk_test_abc123" });
	});
});

describe("encryption", () => {
	it("round-trips", () => {
		const secret = "rk_test_supersecretvalue";
		expect(decryptStripeKey(encryptStripeKey(secret))).toBe(secret);
	});

	it("produces different ciphertext each time, so equal keys are not linkable", () => {
		expect(encryptStripeKey("rk_test_x")).not.toBe(encryptStripeKey("rk_test_x"));
	});

	it("refuses tampered ciphertext rather than returning garbage", () => {
		// GCM's auth tag is the point: a modified ciphertext must fail loudly,
		// not decrypt to something plausible.
		const enc = encryptStripeKey("rk_test_x");
		const [iv, tag, body] = enc.split(":");
		const flipped = body.startsWith("a") ? "b" + body.slice(1) : "a" + body.slice(1);

		expect(() => decryptStripeKey(`${iv}:${tag}:${flipped}`)).toThrow();
	});

	it("refuses a malformed payload", () => {
		expect(() => decryptStripeKey("not-a-payload")).toThrow(/Invalid encrypted Stripe key/);
	});

	it("cannot decrypt under a different key", () => {
		const enc = encryptStripeKey("rk_test_x");
		process.env[KEY] = "a-completely-different-secret";

		expect(() => decryptStripeKey(enc)).toThrow();
	});
});

describe("saveCredential", () => {
	it("REFUSES to store anything when no encryption key is configured", async () => {
		// The failure this exists to prevent: writing a live Stripe credential
		// to a column in plaintext because an env var was missing. The OAuth
		// module degrades gracefully in the same situation; here that would be
		// the wrong trade entirely.
		delete process.env[KEY];
		const { dbClient } = await import("@/lib/db/client");
		const upsert = vi.fn();
		vi.mocked(dbClient).mockReturnValue({ from: () => ({ upsert }) } as never);

		const result = await saveCredential("v1", "rk_live_realkey123");

		expect(result).toEqual({ ok: false, reason: "not_configured" });
		expect(upsert).not.toHaveBeenCalled();
	});

	it("rejects a bad key before reaching storage at all", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const upsert = vi.fn();
		vi.mocked(dbClient).mockReturnValue({ from: () => ({ upsert }) } as never);

		expect(await saveCredential("v1", "sk_live_x")).toEqual({ ok: false, reason: "unrestricted" });
		expect(upsert).not.toHaveBeenCalled();
	});

	it("stores ciphertext and the last four, never the key itself", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const upsert = vi.fn().mockResolvedValue({ error: null });
		vi.mocked(dbClient).mockReturnValue({ from: () => ({ upsert }) } as never);

		await saveCredential("v1", "rk_test_abcdefWXYZ");

		const row = upsert.mock.calls[0][0];
		expect(row.key_last4).toBe("WXYZ");
		expect(row.livemode).toBe(false);
		expect(row.encrypted_key).not.toContain("rk_test_abcdefWXYZ");
		expect(decryptStripeKey(row.encrypted_key)).toBe("rk_test_abcdefWXYZ");
	});

	it("clears the previous key's sync state, so a new key is not blamed for an old fault", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const upsert = vi.fn().mockResolvedValue({ error: null });
		vi.mocked(dbClient).mockReturnValue({ from: () => ({ upsert }) } as never);

		await saveCredential("v1", "rk_test_abcdefWXYZ");

		expect(upsert.mock.calls[0][0]).toMatchObject({ last_synced_at: null, last_sync_error: null });
	});
});

describe("stripeEncryptionConfigured", () => {
	it("reports whether the key is present", () => {
		expect(stripeEncryptionConfigured()).toBe(true);
		delete process.env[KEY];
		expect(stripeEncryptionConfigured()).toBe(false);
	});
});
