import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth/server";
import { OnboardingForm } from "./OnboardingForm";

// Reads the signed-in user's session per request; without this it gets
// prerendered once at build time with no user, same bug caught on the
// homepage (see src/app/page.tsx).
export const dynamic = "force-dynamic";

// The bootstrap page for a signed-in user with no vendor_members row yet
// (see proxy.ts's vendorAuthGate — it's the only /vendor page reachable
// without a membership, because it's the page that creates the first one).
export default async function VendorOnboardingPage() {
	const user = await getUser();

	// Shouldn't normally be reached signed-out — the proxy gates /vendor/* —
	// but redirect defensively rather than rendering a form that will 401.
	if (!user) redirect("/vendor/login");

	return (
		<div className="mx-auto max-w-md">
			<h1 className="text-2xl font-semibold tracking-tight">Set up your vendor</h1>
			<p className="mt-3 text-fog">
				Create your organization to get a publishable key and start collecting attested proof
				events.
			</p>
			<OnboardingForm />
		</div>
	);
}
