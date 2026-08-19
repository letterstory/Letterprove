import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth/server";
import { claimPendingForUser, getClient } from "@/lib/oauth/core";
import { vendorMemberships } from "@/lib/vendors/session";
import { parseScope, scopeDescription, isVendorScoped, isStaffScoped, OFFLINE_ACCESS } from "@/lib/oauth/scopes";
import { isStaffUser } from "@/lib/staff/allowlist";

// Reads the session and a live pending-request row per request; prerendering
// this once at build time would render someone else's login (same bug already
// caught on the homepage and /vendor).
export const dynamic = "force-dynamic";

// The only human step in the CLI login. Kept to the same plain-HTML style as
// the rest of the vendor area — this page exists to be read and clicked once,
// not to be a product surface, and the form posts to a route that does the
// real verification. It lives outside the /vendor prefix on purpose so the
// proxy's vendorAuthGate does not bounce a membership-less user to onboarding
// mid-login; the sign-in redirect below is handled here instead.
export const metadata = { title: "Authorize — Letterprove" };

function Notice({ title, message }: { title: string; message: string }) {
	return (
		<main style={{ maxWidth: 420, margin: "4rem auto", padding: "0 1rem" }}>
			<h1>{title}</h1>
			<p>{message}</p>
		</main>
	);
}

export default async function OAuthConsentPage({ searchParams }: { searchParams: Promise<{ nonce?: string }> }) {
	const { nonce } = await searchParams;
	if (!nonce) {
		return <Notice title="Invalid request" message="This login link is missing required information." />;
	}

	const user = await getUser();
	if (!user) redirect(`/vendor/login?redirect=${encodeURIComponent(`/oauth/consent?nonce=${nonce}`)}`);

	// Claiming binds this pending request to the signed-in user server-side, so
	// the POST that follows can never be re-pointed at someone else's login.
	const claimed = await claimPendingForUser(nonce, user.id);
	if (!claimed) {
		return (
			<Notice
				title="This login link has expired"
				message="Return to your terminal and run the login command again."
			/>
		);
	}

	const client = await getClient(claimed.client_id);
	if (!client) {
		return <Notice title="Unknown application" message="This application is no longer registered." />;
	}

	// offline_access is plumbing, not a permission a person can meaningfully
	// consent to — it is described in the footer instead of listed as a grant.
	const requested = parseScope(claimed.scope).filter((s) => s !== OFFLINE_ACCESS);

	// The CLI's default login asks for every scope its client is registered
	// for (see /api/oauth/authorize), which today always includes vendor:* —
	// so "requested vendor:*" says nothing about whether THIS user can
	// actually exercise it. A user with no vendor memberships isn't blocked;
	// vendor:* is silently dropped from what gets shown and granted, the same
	// way an unsupported scope is dropped in resolveGrantableScope. Only when
	// nothing is left to grant is there truly nothing to authorize.
	const vendors = await vendorMemberships();
	// Mirrors the narrowing the POST handler enforces: a non-staff user is never
	// shown staff scopes, so the consent screen cannot promise a permission the
	// grant will silently drop.
	const entitled = requested.filter((s) => !isStaffScoped(s) || isStaffUser(user.id));
	const scopes = vendors.length > 0 ? entitled : entitled.filter((s) => !isVendorScoped(s));
	const needsVendor = vendors.length > 0 && scopes.some(isVendorScoped);

	if (scopes.length === 0) {
		return (
			<Notice
				title="No vendor account yet"
				message="Your account does not belong to a vendor yet, so there is nothing to authorize. Finish signing up at /vendor first, then run the login command again."
			/>
		);
	}

	return (
		<main style={{ maxWidth: 420, margin: "4rem auto", padding: "0 1rem" }}>
			<h1>
				{client.name} wants access{client.is_first_party ? "" : " to your Letterprove account"}
			</h1>
			<p style={{ color: "#666" }}>Signed in as {user.email}</p>

			<section style={{ marginTop: "2rem" }}>
				<h2>This will allow it to</h2>
				<ul>
					{scopes.map((scope) => (
						<li key={scope}>{scopeDescription(scope)}</li>
					))}
				</ul>
			</section>

			<form
				method="POST"
				action="/api/oauth/authorize/consent"
				style={{ display: "grid", gap: "0.75rem", marginTop: "2rem" }}
			>
				<input type="hidden" name="nonce" value={nonce} />

				{!needsVendor ? (
					<p style={{ color: "#666" }}>This is a staff action and is not tied to any vendor.</p>
				) : vendors.length === 1 ? (
					<>
						<input type="hidden" name="vendor_id" value={vendors[0].id} />
						<p>
							Acting for <strong>{vendors[0].name}</strong>
						</p>
					</>
				) : (
					<label>
						Vendor
						<select name="vendor_id" defaultValue={vendors[0].id} style={{ display: "block", width: "100%" }}>
							{vendors.map((vendor) => (
								<option key={vendor.id} value={vendor.id}>
									{vendor.name}
								</option>
							))}
						</select>
					</label>
				)}

				<div style={{ display: "flex", gap: "0.75rem" }}>
					<button type="submit" name="decision" value="deny">
						Cancel
					</button>
					<button type="submit" name="decision" value="allow">
						Allow
					</button>
				</div>
			</form>

			<p style={{ color: "#666", marginTop: "2rem" }}>
				The terminal stays signed in until you run <code>letterprove logout</code>, which revokes this access.
			</p>
		</main>
	);
}
