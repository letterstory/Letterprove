/**
 * Posts vendor-submitted support requests to Slack via an Incoming Webhook —
 * same mechanism as src/lib/alerts/notify.ts, just a distinct destination
 * (that one is for internal system alerts; this is vendor-facing support,
 * a different channel and audience). No OAuth app install, no bot token:
 * `SUPPORT_SLACK_WEBHOOK_URL` is a single secret env var pointing at a
 * Slack-created webhook for the target channel.
 */

export interface SupportMessage {
	vendorName: string;
	vendorSlug: string;
	userEmail: string;
	message: string;
}

/**
 * Returns ok:false with a message on any failure instead of throwing, so a
 * Slack-side outage degrades to "couldn't send" rather than a 500 that hides
 * the vendor's message entirely.
 */
export async function sendSupportMessage(msg: SupportMessage): Promise<{ ok: boolean; error?: string }> {
	const webhookUrl = process.env.SUPPORT_SLACK_WEBHOOK_URL;
	if (!webhookUrl) {
		console.error("[support] SUPPORT_SLACK_WEBHOOK_URL is not configured");
		return { ok: false, error: "Support channel is not available right now" };
	}

	const text = `*Vendor support request*\n*Vendor:* ${msg.vendorName} (${msg.vendorSlug})\n*From:* ${msg.userEmail}\n\n${msg.message}`;

	try {
		const res = await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		});

		if (!res.ok) {
			console.error("[support] Slack webhook rejected the message", res.status);
			return { ok: false, error: "Failed to send your message. Please try again." };
		}

		return { ok: true };
	} catch (error) {
		console.error("[support] Slack webhook request failed", error instanceof Error ? error.message : error);
		return { ok: false, error: "Failed to send your message. Please try again." };
	}
}
