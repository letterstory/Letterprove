/**
 * Telling a vendor, by email, that something about their proof broke.
 *
 * Until 2026-10-13 every failure went to our own Slack (lib/alerts/notify.ts)
 * and nowhere else: a vendor whose DNS record was removed, whose script
 * stopped sending, or whose Stripe key was revoked watched their proof fall
 * back a tier and was never told why. These are the four incidents a vendor
 * can fix themselves, each emailed once.
 *
 * ONCE PER INCIDENT. `vendor_notifications` holds one row per (vendor, kind,
 * incident); the row is claimed before sending, so overlapping cron runs and
 * retries never email twice. A failed send releases the claim so the next run
 * tries again.
 *
 * Best effort and never throws: a mail outage must not break the cron that
 * noticed the problem. With no RESEND_API_KEY it logs and sends nothing, and
 * claims nothing, so the email goes out once the key exists.
 *
 * Recipient: `vendors.contact_email`, which Letterstory supplies (it is the
 * identity authority; Letterprove holds no user records). No contact, no email.
 */

import { dbClient } from "@/lib/db/client";

const FROM = process.env.LETTERPROVE_EMAIL_FROM || "Letterprove <staff@letterprove.com>";
const REPLY_TO = process.env.LETTERPROVE_EMAIL_REPLY_TO || "support@letterstory.com";
const DASHBOARD = "https://app.letterstory.com/proofs";

export type NoticeKind = "dns_lost" | "collection_quiet" | "stripe_failing" | "posthog_failing";

export interface Notice {
	subject: string;
	/** Plain paragraphs. The dashboard link is added after them. */
	paragraphs: string[];
}

/** The copy for each incident. Pure, so the wording is reviewed in one place. */
export function noticeFor(kind: NoticeKind, ctx: { vendorName: string; domain: string; detail?: string | null }): Notice {
	switch (kind) {
		case "dns_lost":
			return {
				subject: `Your Letterprove domain check for ${ctx.domain} is failing`,
				paragraphs: [
					`We couldn't find the Letterprove TXT record on ${ctx.domain} for two days, so ${ctx.vendorName}'s proof no longer counts that domain as proven. While it's unproven, the proof shows tier 0 and new sign-ins aren't collected.`,
					`Put the TXT record back at your DNS provider (it's shown in your Letterprove setup), then press Check again. Everything picks up where it left off.`,
				],
			};
		case "collection_quiet":
			return {
				subject: `Letterprove hasn't seen a sign-in on ${ctx.domain} for two days`,
				paragraphs: [
					`${ctx.vendorName}'s Letterprove script has been quiet for more than 48 hours after sending sign-ins before. If people are still signing in, the script may have been removed, moved to a new host, or the identify call may no longer run after sign-in.`,
					`Your Letterprove setup shows whether the script is loading and whether events are arriving from a host we don't accept yet.`,
				],
			};
		case "stripe_failing":
			return {
				subject: `Letterprove can't read ${ctx.vendorName}'s Stripe account`,
				paragraphs: [
					`The last three hourly reads of your Stripe account failed, so payments no longer count toward your proof until it works again.${ctx.detail ? ` Stripe said: "${ctx.detail}"` : ""}`,
					`This usually means the restricted key was deleted or lost a permission. Create a new restricted key and connect it again.`,
				],
			};
		case "posthog_failing":
			return {
				subject: `Letterprove can't read ${ctx.vendorName}'s PostHog project`,
				paragraphs: [
					`The last three daily reads of your PostHog project failed, so the company history from PostHog is no longer shown on your proof.${ctx.detail ? ` PostHog said: "${ctx.detail}"` : ""}`,
					`This usually means the personal API key was revoked or lost access to the project. Create a new key with read access and connect it again.`,
				],
			};
	}
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderNotice(notice: Notice): { text: string; html: string } {
	const text = [...notice.paragraphs, `Open your Letterprove setup: ${DASHBOARD}`, "", "Letterprove"].join("\n\n");
	const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;max-width:560px">
${notice.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")}
<p><a href="${DASHBOARD}">Open your Letterprove setup</a></p>
<p style="color:#777;font-size:12px">You're getting this because you set up Letterprove for your company. Reply if you need a hand.</p>
</div>`;
	return { text, html };
}

export type NotifyResult = "sent" | "duplicate" | "no_recipient" | "not_configured" | "failed";

/**
 * Email the vendor about one incident, at most once. `incident` identifies the
 * episode (e.g. the day DNS was lost), so a later, separate failure of the same
 * kind is emailed again.
 */
export async function notifyVendor(
	vendorId: string,
	kind: NoticeKind,
	incident: string,
	opts: { detail?: string | null; fetcher?: typeof fetch } = {},
): Promise<NotifyResult> {
	try {
		const db = dbClient();
		if (!db) return "not_configured";
		const { data: vendor } = await db.from("vendors").select("name, domain, contact_email").eq("id", vendorId).maybeSingle();
		const to = typeof vendor?.contact_email === "string" ? vendor.contact_email.trim() : "";
		if (!vendor || !to) return "no_recipient";

		const key = process.env.RESEND_API_KEY;
		if (!key) {
			console.error(`[letterprove:notify] RESEND_API_KEY is not set; not emailing ${kind} for vendor ${vendorId}`);
			return "not_configured";
		}

		// Claim first. A conflict means this incident was already emailed.
		const { error: claimError } = await db
			.from("vendor_notifications")
			.insert({ vendor_id: vendorId, kind, incident, recipient: to });
		if (claimError) return "duplicate";

		const notice = noticeFor(kind, { vendorName: vendor.name as string, domain: vendor.domain as string, detail: opts.detail });
		const { text, html } = renderNotice(notice);
		const res = await (opts.fetcher ?? fetch)("https://api.resend.com/emails", {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject: notice.subject, text, html }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			await db.from("vendor_notifications").delete().eq("vendor_id", vendorId).eq("kind", kind).eq("incident", incident);
			console.error(`[letterprove:notify] Resend refused ${kind} for vendor ${vendorId}: ${res.status}`);
			return "failed";
		}
		return "sent";
	} catch (e) {
		console.error(`[letterprove:notify] ${kind} for vendor ${vendorId} failed`, e instanceof Error ? e.message : String(e));
		return "failed";
	}
}

/** Day-bucketed incident key for "failing past the threshold" transitions. */
export function incidentDay(at: Date = new Date()): string {
	return at.toISOString().slice(0, 10);
}
