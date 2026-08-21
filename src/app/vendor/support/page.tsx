import { SupportForm } from "./SupportForm";

// Reads the signed-in user's vendor context per request via SupportForm's
// API route — same reasoning as every other /vendor page (see nav.tsx).
export const dynamic = "force-dynamic";

export default function VendorSupportPage() {
	return (
		<div className="mx-auto max-w-md">
			<h1 className="text-2xl font-semibold tracking-tight">Support</h1>
			<p className="mt-3 text-fog">
				Questions, bugs, or anything else — send us a message and we&apos;ll reply by email.
			</p>
			<SupportForm />
		</div>
	);
}
