/**
 * Sends the tier-4 consent request to the customer, via Resend's HTTP API.
 *
 * Raw `fetch` rather than the `resend` npm package, matching
 * src/lib/support/slack.ts and src/lib/alerts/notify.ts — every outbound call
 * in this service is a plain POST to a documented endpoint, and one more
 * dependency is not worth the two lines it would save. (letterbrace does use
 * the SDK; the accounts and sending domain are shared, the client style is
 * not.)
 *
 * The one place this deliberately diverges from letterbrace's senders: those
 * are best-effort and skip silently when RESEND_API_KEY is unset, because a
 * missed notification is a nuisance. This is not a notification. It is the
 * delivery step that binds a counter-signature to the customer's own mailbox,
 * so an unsent email must fail the whole request — see the rollback in
 * consent-link/route.ts. Silently "succeeding" here would leave a live token
 * that only the vendor could reach, which is precisely the hole this closes.
 */

/** Sender. `letterprove.com` is verified on the shared Resend account (Supabase Auth already sends staff@ through it). */
const FROM = process.env.LETTERPROVE_EMAIL_FROM || "Letterprove <staff@letterprove.com>";

export interface ConsentRequestEmail {
	to: string;
	vendorName: string;
	customerName: string;
	/** Absolute URL of the consent page, token included. */
	url: string;
	/** ISO timestamp the link stops working. */
	expiresAt: string;
}

export type SendResult = { ok: true } | { ok: false; error: string };

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function body(msg: ConsentRequestEmail): { subject: string; html: string; text: string } {
	const expires = new Date(msg.expiresAt).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
	});

	// Named plainly: the recipient has no Letterprove account and no reason to
	// know what this is, so the subject has to carry the vendor's name — that
	// is the only word they'll recognise.
	const subject = `${msg.vendorName} would like to name ${msg.customerName} as a customer`;

	const text = [
		`${msg.vendorName} has published an attestation that ${msg.customerName} uses their product,`,
		`and is asking you to confirm it.`,
		``,
		`Review and approve or decline here:`,
		msg.url,
		``,
		`This link expires ${expires}. Nothing is published unless you approve.`,
		``,
		`You received this because ${msg.vendorName} listed this address as a contact at ${msg.customerName}.`,
		`Letterprove — attested proof for AI agents.`,
	].join("\n");

	const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111">
<p><strong>${escapeHtml(msg.vendorName)}</strong> has published an attestation that
<strong>${escapeHtml(msg.customerName)}</strong> uses their product, and is asking you to confirm it.</p>
<p><a href="${escapeHtml(msg.url)}">Review the summary and approve or decline</a></p>
<p style="color:#555;font-size:14px">This link expires ${escapeHtml(expires)}. Nothing is published unless you approve.</p>
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="color:#777;font-size:12px">You received this because ${escapeHtml(msg.vendorName)} listed this
address as a contact at ${escapeHtml(msg.customerName)}. Letterprove — attested proof for AI agents.</p>
</div>`;

	return { subject, html, text };
}

/**
 * Returns ok:false with a vendor-safe message instead of throwing. The caller
 * must treat a false here as a hard failure and clear the token it just
 * minted — the link is only trustworthy if the customer is the one holding it.
 */
export async function sendConsentRequest(msg: ConsentRequestEmail): Promise<SendResult> {
	const key = process.env.RESEND_API_KEY;
	if (!key) {
		console.error("[consent-email] RESEND_API_KEY is not configured; refusing to mint a consent link");
		return { ok: false, error: "Email delivery isn't configured yet, so consent links can't be sent." };
	}

	const { subject, html, text } = body(msg);

	try {
		const res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ from: FROM, to: [msg.to], subject, html, text }),
		});

		if (!res.ok) {
			// Resend puts the reason in the body; log it, but never surface it to
			// the vendor — it can echo the recipient address back at them.
			const detail = await res.text().catch(() => "");
			console.error("[consent-email] Resend rejected the send", res.status, detail.slice(0, 300));
			return { ok: false, error: "Couldn't send the consent email. Check the address and try again." };
		}

		return { ok: true };
	} catch (error) {
		console.error("[consent-email] Resend request failed", error instanceof Error ? error.message : error);
		return { ok: false, error: "Couldn't send the consent email. Please try again." };
	}
}
