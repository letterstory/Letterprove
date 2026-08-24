import { notFound } from "next/navigation";
import { findVendor } from "@/lib/fixtures/vendors";

/**
 * Resolves the vendor here, above the loading boundary, so an unknown one gets
 * a 404 STATUS and not merely a 404 page.
 *
 * The bug this fixes: `/proofs/anything-at-all` answered **HTTP 200** while
 * rendering Next's "could not be found" body. `page.tsx` did call
 * `notFound()`, but by then the response was already committed — `loading.tsx`
 * puts the page inside a Suspense boundary, so the shell flushes (status line
 * and all) the moment the request arrives, and a status cannot be recalled
 * once sent. A human saw a 404; `curl -I` saw success.
 *
 * That split matters more here than on an ordinary site. This page's audience
 * is evaluating agents, and the product is machine-readable provenance. An
 * agent checking whether a vendor publishes proof reads the status, not the
 * prose — and "200, no customers" reads as *"this vendor exists and attests to
 * nothing"*, a materially different and worse claim than *"no such vendor"*.
 * The sibling JSON endpoints already answer 404; this makes the HTML agree.
 *
 * **Why a layout rather than the obvious alternatives**, both of which were
 * built and measured before landing this one:
 *
 *   - Deleting `loading.tsx` also produces a correct 404, but regresses what
 *     #102 deliberately fixed. Its own note — "a real second or two behind a
 *     click" — held up: without it, first byte went from ~0.26s to ~0.70s
 *     locally, and Next holds the *previous* page on screen for that whole
 *     time, so a click reads as ignored.
 *   - `generateMetadata()` is resolved inside the same streamed render, so a
 *     `notFound()` there left the status on 200 exactly as the component's
 *     did.
 *
 * A layout renders *above* the segment's Suspense boundary, so it has to
 * resolve before the shell can flush. That buys the correct status while
 * keeping the skeleton.
 *
 * Cost is one extra `findVendor` per request — a single indexed lookup by
 * slug, on a page that already builds a signed chain per customer.
 */
export default async function ProofLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ vendor: string }>;
}) {
	const { vendor } = await params;
	if (!(await findVendor(vendor))) notFound();

	return <>{children}</>;
}
