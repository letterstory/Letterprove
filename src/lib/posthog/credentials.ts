/**
 * Storing and retrieving a vendor's read-only PostHog credential.
 *
 * Same rules as src/lib/stripe/credentials.ts, whose algorithm this copies:
 * fails closed when no encryption key is configured (a secret that cannot be
 * encrypted is not stored), the plaintext never travels toward a client, and
 * decryption exists only to make an outbound read.
 *
 * Its own encryption variable, for the reason the Stripe module gives: two
 * secrets with different blast radii should be rotatable independently.
 */

import crypto from "node:crypto";
import { dbClient } from "@/lib/db/client";

const ALGORITHM = "aes-256-gcm";

export function posthogEncryptionConfigured(): boolean {
	return Boolean(process.env.LETTERPROVE_POSTHOG_ENCRYPTION_KEY);
}

function getKey(): Buffer {
	const secret = process.env.LETTERPROVE_POSTHOG_ENCRYPTION_KEY;
	if (!secret) throw new Error("LETTERPROVE_POSTHOG_ENCRYPTION_KEY is not set");
	return crypto.createHash("sha256").update(secret).digest();
}

export function encryptPosthogKey(plaintext: string): string {
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
	const encrypted = cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
	return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted}`;
}

export function decryptPosthogKey(ciphertext: string): string {
	const [ivHex, authTagHex, encrypted] = ciphertext.split(":");
	if (!ivHex || !authTagHex || !encrypted) throw new Error("Invalid encrypted PostHog key format");
	const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
	decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
	return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8");
}

/**
 * A PostHog PERSONAL API key (`phx_…`). A project API key (`phc_…`) is public
 * — it ships in every page that loads posthog-js — and can only send events,
 * so it is refused with an explanation rather than stored.
 */
const PERSONAL = /^phx_[A-Za-z0-9]{20,}$/;

export type KeyRejection = "project_key" | "malformed";

export function classifyKey(raw: string): { ok: true; key: string; last4: string } | { ok: false; reason: KeyRejection } {
	const key = raw.trim();
	if (key.startsWith("phc_")) return { ok: false, reason: "project_key" };
	if (!PERSONAL.test(key)) return { ok: false, reason: "malformed" };
	return { ok: true, key, last4: key.slice(-4) };
}

const CLOUD_HOSTS = new Set(["us.posthog.com", "eu.posthog.com", "app.posthog.com"]);

/**
 * The https origin of the PostHog API. Cloud by name; a self-hosted instance
 * by hostname, never an IP literal or a local name, because this is a server
 * making requests wherever a vendor points it.
 */
export function normalizeApiHost(raw: string | undefined): string | null {
	const input = (raw ?? "").trim() || "https://us.posthog.com";
	let url: URL;
	try {
		url = new URL(input.includes("://") ? input : `https://${input}`);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
	const host = url.hostname.toLowerCase();
	// The ingestion hosts (us.i.posthog.com) only accept events; the API lives
	// on the app host. Map them rather than failing a vendor who copied the
	// host out of their posthog-js init.
	const mapped = host === "us.i.posthog.com" ? "us.posthog.com" : host === "eu.i.posthog.com" ? "eu.posthog.com" : host;
	if (CLOUD_HOSTS.has(mapped)) return `https://${mapped}`;
	if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(mapped)) return null;
	if (/^\d+(\.\d+){3}$/.test(mapped) || mapped.endsWith(".local") || mapped.endsWith(".internal") || mapped === "localhost") {
		return null;
	}
	return `https://${mapped}`;
}

export const PROJECT_ID = /^\d{1,12}$/;

export interface PosthogConnection {
	last4: string;
	apiHost: string;
	projectId: string;
	connectedAt: string;
	lastSyncedAt: string | null;
	lastSyncError: string | null;
	hostEvents30d: number | null;
	domainsExcluded: number | null;
	truncated: boolean;
}

/** What a dashboard may see. No key material. */
export async function connectionFor(vendorId: string): Promise<PosthogConnection | null> {
	const db = dbClient();
	if (!db) return null;
	const { data } = await db
		.from("vendor_posthog_credentials")
		.select("key_last4, api_host, project_id, connected_at, last_synced_at, last_sync_error, host_events_30d, domains_excluded, truncated")
		.eq("vendor_id", vendorId)
		.maybeSingle();
	if (!data) return null;
	return {
		last4: data.key_last4,
		apiHost: data.api_host,
		projectId: data.project_id,
		connectedAt: data.connected_at,
		lastSyncedAt: data.last_synced_at,
		lastSyncError: data.last_sync_error,
		hostEvents30d: data.host_events_30d ?? null,
		domainsExcluded: data.domains_excluded ?? null,
		truncated: Boolean(data.truncated),
	};
}

export type SaveResult =
	| { ok: true; last4: string }
	| { ok: false; reason: KeyRejection | "not_configured" | "storage_unavailable" };

export async function saveCredential(
	vendorId: string,
	rawKey: string,
	target: { apiHost: string; projectId: string },
): Promise<SaveResult> {
	const classified = classifyKey(rawKey);
	if (!classified.ok) return { ok: false, reason: classified.reason };
	if (!posthogEncryptionConfigured()) return { ok: false, reason: "not_configured" };
	const db = dbClient();
	if (!db) return { ok: false, reason: "storage_unavailable" };

	const { error } = await db.from("vendor_posthog_credentials").upsert(
		{
			vendor_id: vendorId,
			encrypted_key: encryptPosthogKey(classified.key),
			key_last4: classified.last4,
			api_host: target.apiHost,
			project_id: target.projectId,
			connected_at: new Date().toISOString(),
			last_synced_at: null,
			last_sync_error: null,
			consecutive_sync_failures: 0,
			host_events_30d: null,
			domains_excluded: null,
			truncated: false,
		},
		{ onConflict: "vendor_id" },
	);
	if (error) return { ok: false, reason: "storage_unavailable" };
	// A new key may read a different project; what the old one reported is
	// not this project's history.
	await db.from("vendor_posthog_domains").delete().eq("vendor_id", vendorId);
	return { ok: true, last4: classified.last4 };
}

/** The decrypted key, for one outbound read. Server-side only. */
export async function credentialFor(vendorId: string): Promise<{ key: string; apiHost: string; projectId: string } | null> {
	const db = dbClient();
	if (!db || !posthogEncryptionConfigured()) return null;
	const { data } = await db
		.from("vendor_posthog_credentials")
		.select("encrypted_key, api_host, project_id")
		.eq("vendor_id", vendorId)
		.maybeSingle();
	if (!data) return null;
	try {
		return { key: decryptPosthogKey(data.encrypted_key), apiHost: data.api_host, projectId: data.project_id };
	} catch {
		console.error("[letterprove:posthog] could not decrypt stored credential");
		return null;
	}
}

/** Drops the credential and everything it reported. History must not outlive its source. */
export async function disconnect(vendorId: string): Promise<boolean> {
	const db = dbClient();
	if (!db) return false;
	const cleared = await db.from("vendor_posthog_domains").delete().eq("vendor_id", vendorId);
	if (cleared.error) return false;
	const { error } = await db.from("vendor_posthog_credentials").delete().eq("vendor_id", vendorId);
	return !error;
}
