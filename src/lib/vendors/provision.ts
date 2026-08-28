import { randomUUID, randomBytes } from "node:crypto";
import { dbClient } from "@/lib/db/client";
import { normalizeDomain, domainRejectionReason } from "@/lib/vendors/domain";
import { generateKey } from "@/lib/vendors/keys";
import { findVendorByOrg } from "@/lib/fixtures/vendors";

/**
 * Create the Letterprove vendor a Letterstory org will publish proofs as, and
 * link the two by letterstory_org_id (1:1, migration 20260825060000).
 *
 * This is the DB-write half of the create_vendor tool — the one call the seam
 * (Letterstory #1136) flagged as having "no home on the Letterprove side yet".
 * It mirrors POST /api/vendor/onboarding's insertVendor EXCEPT it never writes
 * a vendor_members row: in the unified model membership lives in Letterstory
 * (organization_users), so a Letterprove vendor has no local members. It uses
 * the service-role client (dbClient) because there is no user session behind a
 * Letterstory-service call.
 *
 * Category has no home here — the seam collects only name + domain, and a
 * Letterstory org carries no category — so it defaults. It is descriptive only
 * (never gates serving), so a default is honest rather than a lossy guess.
 */
const DEFAULT_CATEGORY = "software";

export type ProvisionResult =
	| { ok: true; vendorId: string; slug: string; domain: string }
	| { ok: false; status: number; error: string };

function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export async function provisionVendorForOrg(
	orgId: string,
	input: { name: string; domain: string },
): Promise<ProvisionResult> {
	const db = dbClient();
	if (!db) return { ok: false, status: 500, error: "Storage is not configured." };

	const domain = normalizeDomain(input.domain);
	if (!domain) return { ok: false, status: 400, error: domainRejectionReason(input.domain) };

	const name = (input.name ?? "").trim();
	const baseSlug = slugify(name);
	if (!baseSlug) return { ok: false, status: 400, error: "Vendor name must contain letters or numbers." };

	// Friendly pre-check for the common case; the partial-unique index on
	// letterstory_org_id is the real guard, so a race that slips past this still
	// fails closed as a 23505 below (handled as a conflict, never a duplicate).
	if (await findVendorByOrg(orgId)) {
		return { ok: false, status: 409, error: "This organization already has a Letterprove vendor." };
	}

	const key = generateKey(baseSlug);

	const insert = async (slug: string): Promise<{ id: string } | "conflict" | "error"> => {
		const id = randomUUID();
		const { error } = await db
			.from("vendors")
			.insert({ id, slug, name, domain, category: DEFAULT_CATEGORY, key, letterstory_org_id: orgId });
		if (!error) return { id };
		// 23505 is unique_violation — could be the slug OR the org link. Either
		// way the caller should not retry blindly, so it is surfaced as conflict.
		return error.code === "23505" ? "conflict" : "error";
	};

	let slug = baseSlug;
	let res = await insert(slug);
	if (res === "conflict") {
		// Retry once for a slug collision with a short random suffix — same as
		// onboarding. A second conflict means the ORG is already linked (the
		// suffix makes a slug re-collision vanishingly unlikely), so stop.
		slug = `${baseSlug}-${randomBytes(2).toString("hex")}`;
		res = await insert(slug);
	}

	if (res === "conflict") {
		return { ok: false, status: 409, error: "This organization already has a Letterprove vendor." };
	}
	if (res === "error") return { ok: false, status: 500, error: "Could not create the vendor." };

	return { ok: true, vendorId: res.id, slug, domain };
}
