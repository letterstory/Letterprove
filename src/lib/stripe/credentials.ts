/**
 * Storing and retrieving a vendor's read-only Stripe credential.
 *
 * FAILS CLOSED, which is the one way this differs from the OAuth encryption
 * module it borrows its algorithm from. That module deliberately SKIPS its
 * cache when the key is unset, because the only cost there is a retried
 * refresh looking like reuse. Here the equivalent shortcut would be writing a
 * live Stripe credential to a column in plaintext, so a missing key refuses
 * the write instead. A secret that cannot be encrypted must not be stored.
 *
 * The plaintext key never leaves this module toward a client. `connectionFor`
 * returns state a dashboard can render — last four, live or test, when it was
 * connected, what the last sync said — and no route exposes anything more.
 * Decryption exists only to make an outbound call to Stripe.
 */

import crypto from "node:crypto";
import { dbClient } from "@/lib/db/client";

const ALGORITHM = "aes-256-gcm";

/**
 * Its own variable rather than sharing the OAuth one. Two secrets with
 * different blast radii should be rotatable independently: rotating this
 * disconnects vendors from Stripe, rotating that one invalidates a
 * retry cache, and being forced to do both at once makes the safer action
 * the more expensive one.
 */
export function stripeEncryptionConfigured(): boolean {
	return Boolean(process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY);
}

function getKey(): Buffer {
	const secret = process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY;
	if (!secret) throw new Error("LETTERPROVE_STRIPE_ENCRYPTION_KEY is not set");
	return crypto.createHash("sha256").update(secret).digest();
}

/** Format: iv:authTag:ciphertext, all hex — same shape as the OAuth module. */
export function encryptStripeKey(plaintext: string): string {
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
	const encrypted = cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
	return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted}`;
}

export function decryptStripeKey(ciphertext: string): string {
	const [ivHex, authTagHex, encrypted] = ciphertext.split(":");
	if (!ivHex || !authTagHex || !encrypted) throw new Error("Invalid encrypted Stripe key format");

	const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
	decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
	return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8");
}

/**
 * Stripe key prefixes we accept, and the ones we refuse.
 *
 * `rk_` is a restricted key, scoped in Stripe's own dashboard to the resources
 * it may read. `sk_` is unrestricted and can do anything to the account,
 * including refunds — a vendor pasting one in is handing over far more than
 * this product needs, so it is refused with an explanation rather than
 * accepted quietly. Publishable keys (`pk_`) cannot read subscriptions at all.
 */
const RESTRICTED = /^rk_(test|live)_[A-Za-z0-9]+$/;
const UNRESTRICTED = /^sk_(test|live)_/;

export type KeyRejection = "unrestricted" | "publishable" | "malformed";

export function classifyKey(
	raw: string
): { ok: true; key: string; livemode: boolean; last4: string } | { ok: false; reason: KeyRejection } {
	const key = raw.trim();

	if (UNRESTRICTED.test(key)) return { ok: false, reason: "unrestricted" };
	if (key.startsWith("pk_")) return { ok: false, reason: "publishable" };
	if (!RESTRICTED.test(key)) return { ok: false, reason: "malformed" };

	return { ok: true, key, livemode: key.startsWith("rk_live_"), last4: key.slice(-4) };
}

export interface StripeConnection {
	last4: string;
	livemode: boolean;
	connectedAt: string;
	lastSyncedAt: string | null;
	lastSyncError: string | null;
	/** Stripe products that count as this vendor's product. Empty = every product. */
	productIds: string[];
	/** The account the key belongs to, as last read. Null before the first read. */
	stripeAccountId: string | null;
	stripeAccountDomains: string[];
	accountCheckedAt: string | null;
}

/** What a dashboard may see. Deliberately no key material of any kind. */
export async function connectionFor(vendorId: string): Promise<StripeConnection | null> {
	const db = dbClient();
	if (!db) return null;

	const { data } = await db
		.from("vendor_stripe_credentials")
		.select(
			"key_last4, livemode, connected_at, last_synced_at, last_sync_error, product_ids, stripe_account_id, stripe_account_domains, account_checked_at",
		)
		.eq("vendor_id", vendorId)
		.maybeSingle();

	if (!data) return null;
	return {
		last4: data.key_last4,
		livemode: data.livemode,
		connectedAt: data.connected_at,
		lastSyncedAt: data.last_synced_at,
		lastSyncError: data.last_sync_error,
		productIds: data.product_ids ?? [],
		stripeAccountId: data.stripe_account_id ?? null,
		stripeAccountDomains: data.stripe_account_domains ?? [],
		accountCheckedAt: data.account_checked_at ?? null,
	};
}

export type SaveResult =
	| { ok: true; livemode: boolean; last4: string }
	| { ok: false; reason: KeyRejection | "not_configured" | "storage_unavailable" };

export interface SaveOptions {
	/** Replace the product scope. Omitted keeps whatever scope the vendor already chose. */
	productIds?: string[];
	/** The account the key was just checked against, recorded with it. */
	account?: { id: string; domains: string[] };
}

export async function saveCredential(vendorId: string, rawKey: string, options: SaveOptions = {}): Promise<SaveResult> {
	const classified = classifyKey(rawKey);
	if (!classified.ok) return { ok: false, reason: classified.reason };

	// Before touching the database, not after: the failure mode this guards is
	// writing a live credential in plaintext because an env var was missing.
	if (!stripeEncryptionConfigured()) return { ok: false, reason: "not_configured" };

	const db = dbClient();
	if (!db) return { ok: false, reason: "storage_unavailable" };

	const { error } = await db.from("vendor_stripe_credentials").upsert(
		{
			vendor_id: vendorId,
			encrypted_key: encryptStripeKey(classified.key),
			key_last4: classified.last4,
			livemode: classified.livemode,
			connected_at: new Date().toISOString(),
			// A newly connected key has never synced, and carrying a previous
			// key's error forward would blame the new one for the old one's fault.
			last_synced_at: null,
			last_sync_error: null,
			...(options.productIds ? { product_ids: options.productIds } : {}),
			...(options.account
				? {
						stripe_account_id: options.account.id,
						stripe_account_domains: options.account.domains,
						account_checked_at: new Date().toISOString(),
					}
				: {}),
		},
		{ onConflict: "vendor_id" }
	);

	if (error) return { ok: false, reason: "storage_unavailable" };
	return { ok: true, livemode: classified.livemode, last4: classified.last4 };
}

/**
 * The decrypted key, for making one outbound Stripe call. Server-side callers
 * only — nothing that returns this to a client should exist, and there is no
 * route in the codebase that does.
 */
export async function credentialFor(
	vendorId: string
): Promise<{ key: string; livemode: boolean; productIds: string[] } | null> {
	const db = dbClient();
	if (!db || !stripeEncryptionConfigured()) return null;

	const { data } = await db
		.from("vendor_stripe_credentials")
		.select("encrypted_key, livemode, product_ids")
		.eq("vendor_id", vendorId)
		.maybeSingle();

	if (!data) return null;
	try {
		return { key: decryptStripeKey(data.encrypted_key), livemode: data.livemode, productIds: data.product_ids ?? [] };
	} catch {
		// Wrong key, or a rotated one. Null rather than throwing: the caller's
		// job is to report "reconnect Stripe", not to crash a dashboard render.
		console.error("[letterprove:stripe] could not decrypt stored credential");
		return null;
	}
}

/** Stripe product ids look like `prod_…`. Anything else is refused rather than stored. */
export const PRODUCT_ID = /^prod_[A-Za-z0-9]+$/;

/**
 * Replace which Stripe products count as this vendor's product. Empty means
 * every product. Takes effect at the next sync, which replaces evidence
 * wholesale, so narrowing the scope can only remove evidence, never strand it.
 */
export async function setProductScope(vendorId: string, productIds: string[]): Promise<boolean> {
	const db = dbClient();
	if (!db) return false;
	const { error } = await db
		.from("vendor_stripe_credentials")
		.update({ product_ids: [...new Set(productIds)].sort() })
		.eq("vendor_id", vendorId);
	return !error;
}

/**
 * Drops the credential AND the evidence it produced.
 *
 * Evidence must not outlive its source. `vendor_payment_evidence` is read
 * fresh on every publish (see attest/body.ts), so a row left behind after a
 * disconnect goes on asserting, in the present tense, that a named customer
 * pays this vendor. Nothing in the system could ever contradict it again,
 * because the sync that replaces evidence wholesale can no longer run without
 * a key. That is the same staleness sync.ts deletes to prevent, at the one
 * moment sync is never coming back.
 *
 * Evidence first, credential second, on purpose. Either half failing leaves a
 * state a retry fixes: evidence gone with the key still connected is a vendor
 * who can sync again, where a key gone with the evidence still standing is the
 * unfalsifiable claim above.
 */
export async function disconnect(vendorId: string): Promise<boolean> {
	const db = dbClient();
	if (!db) return false;

	const cleared = await db.from("vendor_payment_evidence").delete().eq("vendor_id", vendorId);
	if (cleared.error) return false;
	const clearedUnmatched = await db.from("vendor_payment_unmatched").delete().eq("vendor_id", vendorId);
	if (clearedUnmatched.error) return false;

	const { error } = await db.from("vendor_stripe_credentials").delete().eq("vendor_id", vendorId);
	return !error;
}
