import { getUser } from "@/lib/auth/server";
import { SignOutButton } from "./SignOutButton";

// getUser() reads the request's cookies, so this route can't be statically
// prerendered — without this, Next bakes one build-time (signed-out) render
// and serves it to everyone (see the same fix on `/` and `/vendor/*`).
export const dynamic = "force-dynamic";

// Placeholder landing for the staff area — proves the auth wall end-to-end
// (middleware.ts redirects here only when signed in). No staff feature lives
// here yet; the first real one (e.g. vendor/customer/consent management,
// currently done by hand-editing src/lib/fixtures/vendors.ts) is a product
// decision, not an auth-infra one.
export default async function StaffHome() {
	const user = await getUser();

	return (
		<main style={{ maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }}>
			<h1>Letterprove staff</h1>
			<p>Signed in as {user?.email}.</p>
			<SignOutButton />
		</main>
	);
}
