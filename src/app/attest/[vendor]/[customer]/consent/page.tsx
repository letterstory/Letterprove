import { DevKeyBanner, SiteFooter, SiteHeader } from "@/components/chrome";
import { lookupConsentRequest, type ConsentPreview } from "@/lib/vendors/consent";

// Reads a live token against the DB on every request — the whole point of
// the token is that it's single-use-until-expiry, so caching or prerendering
// this would show a stale answer to the one visitor who most needs a correct
// one.
export const dynamic = "force-dynamic";

export const metadata = { title: "Confirm your usage — Letterprove" };

function Notice({ title, message }: { title: string; message: string }) {
	return (
		<main className="mx-auto max-w-lg px-6 py-24 text-center">
			<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
			<p className="mt-3 text-fog">{message}</p>
		</main>
	);
}

export default async function ConsentPage({
	params,
	searchParams,
}: {
	params: Promise<{ vendor: string; customer: string }>;
	searchParams: Promise<{ token?: string; done?: string }>;
}) {
	const { vendor, customer } = await params;
	const { token, done } = await searchParams;

	if (done === "approve") {
		return (
			<>
				<DevKeyBanner />
				<SiteHeader />
				<Notice
					title="Thanks — you're confirmed"
					message="You've approved this usage summary and agreed to be named. It's now signed under your own confirmation, the strongest form of proof this system produces."
				/>
				<SiteFooter />
			</>
		);
	}
	if (done === "decline") {
		return (
			<>
				<DevKeyBanner />
				<SiteHeader />
				<Notice title="Got it" message="You declined. Nothing was published, and this link no longer works." />
				<SiteFooter />
			</>
		);
	}

	if (!token) {
		return (
			<>
				<DevKeyBanner />
				<SiteHeader />
				<Notice
					title="Missing link information"
					message="This page needs the link a vendor sent you — check that you copied the whole URL."
				/>
				<SiteFooter />
			</>
		);
	}

	const lookup = await lookupConsentRequest(vendor, customer, token);

	return (
		<>
			<DevKeyBanner />
			<SiteHeader />
			{lookup.status === "invalid" && (
				<Notice
					title="This link isn't valid"
					message="It may have already been used, or the vendor may have issued a newer one. Ask them to resend it."
				/>
			)}
			{lookup.status === "expired" && (
				<Notice
					title="This link has expired"
					message="Consent links stay live for 7 days. Ask the vendor to send you a new one."
				/>
			)}
			{lookup.status === "already_countersigned" && (
				<Notice
					title="Already confirmed"
					message={`${lookup.customerName} already approved this — there's nothing left to do here.`}
				/>
			)}
			{lookup.status === "ready" && <ConsentForm preview={lookup.preview} token={token} />}
			<SiteFooter />
		</>
	);
}

function ConsentForm({ preview, token }: { preview: ConsentPreview; token: string }) {
	return (
		<main className="mx-auto max-w-lg px-6 py-14">
			<p className="font-mono text-sm text-mint">confirm your usage</p>
			<h1 className="mt-3 text-3xl font-semibold tracking-tight">{preview.vendorName}</h1>
			<p className="mt-2 text-fog">
				{preview.vendorName} would like to publish the following as a signed customer proof, confirmed
				directly by you rather than asserted by them.
			</p>

			<dl className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-edge bg-edge">
				<Tile label="Customer name" value={preview.customerName} />
				<Tile label="Domain" value={preview.domain} />
				<Tile label="Customer since" value={preview.since} />
				<Tile label="Sessions / 30d" value={preview.sessions30d.toLocaleString("en-US")} />
				<Tile label="Seats active" value={String(preview.seatsActive)} />
				<Tile label="Features in use" value={preview.features.length ? preview.features.join(", ") : "none"} />
			</dl>

			<p className="mt-6 text-sm text-fog">
				Approving confirms this is accurate and agrees to being named as a customer. Nothing is
				published if you decline, and either choice finishes this link.
			</p>

			<form
				method="POST"
				action={`/attest/${preview.vendorSlug}/${preview.customerSlug}/consent/respond`}
				className="mt-6 flex gap-3"
			>
				<input type="hidden" name="token" value={token} />
				<button
					type="submit"
					name="decision"
					value="decline"
					className="rounded border border-edge px-4 py-2 text-sm text-fog hover:border-fog"
				>
					Decline
				</button>
				<button
					type="submit"
					name="decision"
					value="approve"
					className="rounded border border-mint/30 bg-mint/10 px-4 py-2 text-sm font-medium text-mint hover:bg-mint/20"
				>
					Approve &amp; confirm
				</button>
			</form>
		</main>
	);
}

function Tile({ label, value }: { label: string; value: string }) {
	return (
		<div className="bg-panel px-4 py-4">
			<dt className="text-xs tracking-wider text-fog uppercase">{label}</dt>
			<dd className="mt-1 font-medium">{value}</dd>
		</div>
	);
}
