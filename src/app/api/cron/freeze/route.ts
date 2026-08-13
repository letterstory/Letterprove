import { freezeSnapshots } from "@/rollup/freeze";

/**
 * Vercel Cron hits this hourly, 5 minutes after /api/cron/rollup (see
 * vercel.json) so the hour it freezes already has hot_rollups written for
 * it. Not open to arbitrary callers: Vercel signs its own cron invocations
 * with `Authorization: Bearer $CRON_SECRET`, so an unset secret fails
 * closed rather than leaving the endpoint open.
 */
export async function GET(request: Request) {
	const auth = request.headers.get("authorization");
	if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
		return new Response("unauthorized", { status: 401 });
	}

	const result = await freezeSnapshots();
	return Response.json(result, { status: result.ok ? 200 : 500 });
}
