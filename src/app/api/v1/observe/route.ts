import { hostnameOf } from "@/lib/vendors/domain";
import { findVendorByKey } from "@/lib/fixtures/vendors";
import { collectorResponse } from "@/lib/http";
import { oauthClientIp, oauthRateLimit } from "@/lib/oauth/ratelimit";
import { parseObservePayload } from "@/lib/telemetry/events";
import { recordObservation } from "@/lib/telemetry/record";
import { MAX_OBSERVE_BODY_BYTES, readBodyWithLimit } from "@/lib/telemetry/request-limits";

/** Per source IP — bounds a flood regardless of whether the key it's sending is even real (an invalid key still costs a DB round-trip in findVendorByKey below). */
const OBSERVE_IP_LIMIT_PER_MINUTE = 300;
/** Per vendor key, once it resolves to a real vendor — bounds a single leaked/abused key so it can't run up one vendor's DB load (or, later, rollup numbers) at everyone else's expense. */
const OBSERVE_VENDOR_LIMIT_PER_MINUTE = 3000;

/**
 * `POST /v1/observe` — see README § Event schema.
 *
 * sendBeacon-safe: always `204`, key-scoped, origin-pinned. The body is
 * parsed as JSON regardless of `Content-Type`, because `navigator.sendBeacon`
 * can't reliably set it — it often lands as `text/plain`, and treating that
 * as an error would make `attest.js` intermittently "fail" in a way that
 * looks like a client bug and isn't.
 *
 * Public and unauthenticated by design (any vendor's installed script posts
 * here), which is exactly what makes it worth capping rather than trusting
 * every request that arrives:
 *   - Size: capped at MAX_OBSERVE_BODY_BYTES (request-limits.ts) before any
 *     parsing or DB work happens.
 *   - Volume: IP-scoped first, then vendor-key-scoped once the key resolves.
 *     Both reuse the same Postgres-backed fixed-window limiter the OAuth
 *     endpoints already use — see src/lib/oauth/ratelimit.ts, which is
 *     generic despite its module path.
 */
export async function POST(request: Request) {
	if (!(await oauthRateLimit(`observe:ip:${oauthClientIp(request)}`, 60, OBSERVE_IP_LIMIT_PER_MINUTE))) {
		return collectorResponse(false);
	}

	const raw = await readBodyWithLimit(request, MAX_OBSERVE_BODY_BYTES);
	const body = raw === undefined ? undefined : parseJson(raw);
	const payload = body === undefined ? null : parseObservePayload(body);
	if (!payload) return collectorResponse(false);

	const vendor = await findVendorByKey(payload.k);
	if (!vendor) return collectorResponse(false);

	if (!(await oauthRateLimit(`observe:vendor:${vendor.slug}`, 60, OBSERVE_VENDOR_LIMIT_PER_MINUTE))) {
		return collectorResponse(false);
	}

	/*
	 * Origin-pinning trust boundary — read this before trying to "harden" it
	 * further.
	 *
	 * The publishable key (`k`) is NOT a secret: it ships in the vendor's page
	 * HTML by design (src/lib/vendors/install.ts), so the key alone can't
	 * authenticate a request. Origin is the second factor, and it's genuinely
	 * unspoofable from the one client that matters most here: a real browser
	 * cannot let script override the `Origin` header (it's a forbidden header
	 * name), so a request that actually came from `vendor.domain`'s own page
	 * cannot lie about it. What Origin does NOT stop is a non-browser client —
	 * curl, a server-to-server script — setting an arbitrary Origin header.
	 * That's trivial, and no amount of string-comparing here changes it.
	 *
	 * This is a known, accepted limit of the current design, not an oversight.
	 * README § "The trust model" puts a vendor-fabricated payload at Tier 1/2 —
	 * "forgeable ... with effort" — and the plan was always for a determined
	 * spoofing rig to be caught downstream by ASN-distribution fraud features,
	 * not stopped here by Origin-pinning (ASN capture isn't wired yet — see
	 * record.ts). Until it is, the rate limits above are the real backstop
	 * against a spoofing rig's *volume*, even though neither they nor Origin
	 * stop a single well-formed forged request. Cryptographically binding a
	 * request to a vendor (e.g. a per-customer signing secret) would close
	 * this for real, but that's a phase-2+ redesign with its own trust-tier
	 * plumbing — not something to bolt on here piecemeal.
	 */
	const origin = hostnameOf(request.headers.get("origin"));
	if (!origin || origin !== vendor.domain) return collectorResponse(false);

	/*
	 * Refuse anything from a vendor who has not proven DNS control of the
	 * domain they claim.
	 *
	 * Capping their published tier at 0 (which earned() also does) is not
	 * enough on its own. If an unverified vendor may still collect, whoever
	 * registers a domain FIRST establishes a foothold on it — events, rollups,
	 * history — before the real owner ever arrives. Refusing at the door means
	 * an impersonator accumulates nothing at all, and the legitimate owner
	 * verifies into a clean slate rather than one already occupied.
	 *
	 * Same silent 204 as every other refusal here: this endpoint is
	 * sendBeacon-safe and must never surface collection state to a page. The
	 * vendor sees it in the dashboard, which tells them plainly that nothing
	 * is counted until they verify.
	 */
	if (!vendor.domainVerified) return collectorResponse(false);

	await recordObservation({
		vendor: vendor.slug,
		domain: payload.domain,
		ev: payload.ev,
		cfg: payload.cfg,
		origin,
	});

	return collectorResponse(true);
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

