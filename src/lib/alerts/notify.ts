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
 * REPEATS ARE SUPPRESSED, and only the webhook half is. The split is the whole
 * point: the console line is the record of how long a condition has been
 * failing and costs nobody an interruption, so it is written on every single
 * occurrence. The webhook is the interruption, so it is rate limited per
 * subject by src/lib/alerts/state.ts. Nothing is lost by suppressing a page
 * that the log has not already kept.
 *
 * Never throws: an alert that crashes its caller turns "tell a human" into a
 * second outage. That now covers the suppression lookup too, which is written
 * to fail toward sending for the same reason.
 */

import { shouldSendAlert } from "./state";

export async function sendAlert(subject: string, detail: string): Promise<void> {
	const line = `[letterprove:alert] ${subject}: ${detail}`;

	// Decided before the log line is written so the line itself can say whether
	// a page went with it. Reading "suppressed" in the logs is the difference
	// between a quiet Slack channel that is working and one that is broken.
	const decision = await shouldSendAlert(subject);

	const suffix = decision.context ? ` [${decision.context}]` : decision.send ? "" : " [repeat, page suppressed]";
	console.error(`${line}${suffix}`);

	if (!decision.send) return;

	const webhookUrl = process.env.ALERT_WEBHOOK_URL;
	if (!webhookUrl) return;

	try {
		await fetch(webhookUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: `${line}${suffix}` }),
		});
	} catch (error) {
		console.error("[letterprove:alert] webhook delivery failed", error instanceof Error ? error.message : error);
	}
}
