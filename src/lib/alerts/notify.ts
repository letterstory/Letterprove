/**
 * The only alerting primitive in this codebase. Deliberately single-purpose:
 * emit a structured `console.error` line — visible in Vercel's own Runtime
 * Logs / Error tracking today, and picked up by a Log Drain the moment one is
 * wired, with no code change — and, if `ALERT_WEBHOOK_URL` is configured,
 * also POST it there.
 *
 * `ALERT_WEBHOOK_URL` is expected to be a Slack incoming-webhook URL (or
 * anything else that accepts `{ text: string }` — Slack's is the common
 * shape and the cheapest thing to point this at). It is set in production;
 * where it is not (previews, local), the console.error line is the whole
 * alert, which is still strictly more visible than silence.
 *
 * Never throws: an alert that crashes its caller turns "tell a human" into a
 * second outage.
 */
export async function sendAlert(subject: string, detail: string): Promise<void> {
	const line = `[letterprove:alert] ${subject}: ${detail}`;
	console.error(line);

	const webhookUrl = process.env.ALERT_WEBHOOK_URL;
	if (!webhookUrl) return;

	try {
		await fetch(webhookUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: line }),
		});
	} catch (error) {
		console.error("[letterprove:alert] webhook delivery failed", error instanceof Error ? error.message : error);
	}
}
