import { checkCollectorHealth } from "@/lib/telemetry/health";
import { sendAlert } from "@/lib/alerts/notify";

/**
 * Vercel Cron hits this every 15 minutes (see vercel.json). Pages a human
 * when the collector's write path is broken — the failure mode described in
 * src/lib/telemetry/record.ts: an insert error is swallowed there on purpose
 * ("telemetry must never break the collector"), which also means it's
 * invisible unless something goes looking for it. Two prior outages
 * (src/lib/vendors/install.ts's header comment: a wrong install host 404ing
 * for 65 hours, and a snippet pointing at a host that never existed) went
 * unnoticed for exactly this reason — nothing was looking.
 *
 * Not open to arbitrary callers, same posture as the other crons: Vercel
 * signs its own cron invocations with `Authorization: Bearer $CRON_SECRET`,
 * so an unset secret fails closed rather than leaving the endpoint open.
 */
export async function GET(request: Request) {
	const auth = request.headers.get("authorization");
	if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
		return new Response("unauthorized", { status: 401 });
	}

	let health: { ok: boolean; detail: string };
	try {
		health = await checkCollectorHealth();
	} catch (error) {
		// checkCollectorHealth() isn't expected to throw, but this route exists
		// precisely because an unexpected failure must never go unreported —
		// the one thing it must not do is let a throw here look like "cron
		// didn't run" instead of "collector is broken."
		health = { ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
	}

	if (!health.ok) {
		await sendAlert("collector health check failed", health.detail);
	}

	return Response.json(health, { status: health.ok ? 200 : 500 });
}
