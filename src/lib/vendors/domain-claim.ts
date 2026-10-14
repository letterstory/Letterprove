import { dbClient } from "@/lib/db/client";

/**
 * DNS proof outranks every unproven claim to the same domain.
 *
 * Since 2026-10-14 a vendor may collect and publish before it proves its
 * domain by DNS (lib/attest/domain-proof.ts). Several unproven vendors may name
 * the same domain (only DNS-verified domains are unique,
 * vendors_verified_domain_unique). The moment one of them, or the real owner,
 * proves it by DNS, every other vendor naming that domain loses it: its proofs
 * are taken private (unpublishRivals, called from verify_domain) and the
 * collector refuses its events (rivalHoldsDomain, read by /v1/observe and
 * publish_proofs). An impersonator can hold an unproven claim only until the
 * owner shows up, and it never outlives them.
 */

const cache = new Map<string, { held: boolean; at: number }>();
const TTL_MS = 60_000;

/** Whether a vendor other than `vendorId` has proven `domain` by DNS. Cached a minute per instance. */
export async function rivalHoldsDomain(domain: string, vendorId: string): Promise<boolean> {
	const k = `${vendorId}:${domain}`;
	const hit = cache.get(k);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.held;
	const db = dbClient();
	if (!db) return false;
	const { data } = await db.from("vendors").select("id").eq("domain", domain).not("domain_verified_at", "is", null);
	const held = ((data ?? []) as { id: string }[]).some((r) => r.id !== vendorId);
	cache.set(k, { held, at: Date.now() });
	return held;
}

/** Take private every OTHER vendor still naming `domain` without DNS proof. Returns their slugs. Never throws. */
export async function unpublishRivals(domain: string, ownerId: string): Promise<string[]> {
	const db = dbClient();
	if (!db) return [];
	try {
		const { data } = await db
			.from("vendors")
			.select("id, slug")
			.eq("domain", domain)
			.is("domain_verified_at", null)
			.not("proofs_published_at", "is", null);
		const rivals = ((data ?? []) as { id: string; slug: string }[]).filter((r) => r.id !== ownerId);
		if (rivals.length === 0) return [];
		await db.from("vendors").update({ proofs_published_at: null }).in("id", rivals.map((r) => r.id));
		return rivals.map((r) => r.slug);
	} catch (e) {
		console.error(`[letterprove:domain-claim] ${e instanceof Error ? e.message : String(e)}`);
		return [];
	}
}
