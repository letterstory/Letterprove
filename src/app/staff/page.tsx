import Link from "next/link";
import { getUser } from "@/lib/auth/server";
import { SignOutButton } from "./SignOutButton";

// getUser() reads the request's cookies, so this route can't be statically
// prerendered — without this, Next bakes one build-time (signed-out) render
// and serves it to everyone (see the same fix on `/` and `/vendor/*`).
export const dynamic = "force-dynamic";

// Landing for the staff area. The auth wall itself is middleware.ts, which
// redirects here only when signed in; getUser() below re-checks rather than
// trusting that it did.
export default async function StaffHome() {
	const user = await getUser();

	return (
		<main style={{ maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }}>
			<h1>Letterprove staff</h1>
			<p>Signed in as {user?.email}.</p>

			<ul style={{ margin: "2rem 0", paddingLeft: "1.1rem" }}>
				<li>
					<Link href="/staff/tiers">Verification tiers</Link> — what has been observed, and
					what is stopping each domain from being a published claim.
				</li>
			</ul>

			<SignOutButton />
		</main>
	);
}
