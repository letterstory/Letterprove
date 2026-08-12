import { findVendorByKey } from "@/lib/fixtures/vendors";
import { collectorResponse } from "@/lib/http";
import { parseObservePayload } from "@/lib/telemetry/events";
import { recordObservation } from "@/lib/telemetry/record";

/**
 * `POST /v1/observe` — see README § Event schema.
 *
 * sendBeacon-safe: always `204`, key-scoped, origin-pinned. The body is
 * parsed as JSON regardless of `Content-Type`, because `navigator.sendBeacon`
 * can't reliably set it — it often lands as `text/plain`, and treating that
 * as an error would make `attest.js` intermittently "fail" in a way that
 * looks like a client bug and isn't.
 */
export async function POST(request: Request) {
	const body = await parseJsonBody(request);
	const payload = body === undefined ? null : parseObservePayload(body);
	if (!payload) return collectorResponse(false);

	const vendor = findVendorByKey(payload.k);
	if (!vendor) return collectorResponse(false);

	const origin = originHostname(request.headers.get("origin"));
	if (!origin || origin !== vendor.domain) return collectorResponse(false);

	await recordObservation({
		vendor: vendor.slug,
		domain: payload.domain,
		ev: payload.ev,
		cfg: payload.cfg,
		origin,
	});

	return collectorResponse(true);
}

async function parseJsonBody(request: Request): Promise<unknown> {
	try {
		return JSON.parse(await request.text());
	} catch {
		return undefined;
	}
}

function originHostname(origin: string | null): string | null {
	if (!origin) return null;
	try {
		return new URL(origin).hostname.toLowerCase();
	} catch {
		return null;
	}
}
