import crypto from "node:crypto";

/**
 * AES-256-GCM, used for exactly one thing: the refresh-token rotation
 * idempotency cache (oauth_refresh_tokens.encrypted_successor). Tokens
 * themselves are never stored recoverably — they are SHA-256 hashes (see
 * tokens.ts). This caches an already-issued successor pair so a retried
 * refresh replays it instead of tripping reuse detection.
 *
 * With LETTERPROVE_OAUTH_ENCRYPTION_KEY unset the cache is skipped entirely
 * rather than encrypting under a guessable constant: a missing key must not
 * quietly downgrade the protection, and the only cost is that a network-retried
 * refresh looks like reuse and logs that session out. The sister product shipped
 * an incident from exactly this env var being unset in production, so the
 * behaviour is explicit and testable here instead of implicit.
 */
export function oauthEncryptionConfigured(): boolean {
	return Boolean(process.env.LETTERPROVE_OAUTH_ENCRYPTION_KEY);
}

function getKey(): Buffer {
	const secret = process.env.LETTERPROVE_OAUTH_ENCRYPTION_KEY;
	if (!secret) throw new Error("LETTERPROVE_OAUTH_ENCRYPTION_KEY is not set");
	return crypto.createHash("sha256").update(secret).digest();
}

/** Format: iv:authTag:ciphertext (all hex-encoded). */
export function encryptOAuthPayload(plaintext: string): string {
	const key = getKey();
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

	let encrypted = cipher.update(plaintext, "utf8", "hex");
	encrypted += cipher.final("hex");
	const authTag = cipher.getAuthTag().toString("hex");

	return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decryptOAuthPayload(ciphertext: string): string {
	const key = getKey();
	const [ivHex, authTagHex, encrypted] = ciphertext.split(":");

	if (!ivHex || !authTagHex || !encrypted) {
		throw new Error("Invalid encrypted OAuth payload format");
	}

	const iv = Buffer.from(ivHex, "hex");
	const authTag = Buffer.from(authTagHex, "hex");

	if (iv.length !== 16 || authTag.length !== 16) {
		throw new Error("Invalid encrypted OAuth payload: corrupted IV or auth tag");
	}

	const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(authTag);

	let decrypted = decipher.update(encrypted, "hex", "utf8");
	decrypted += decipher.final("utf8");

	return decrypted;
}
