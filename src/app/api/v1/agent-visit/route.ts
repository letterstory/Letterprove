import { after } from "next/server";
import { clientIp, parseIp } from "@/lib/access/verify-agent";
import { classifyVisit, normalizePath, recordAgentVisit } from "@/lib/agents/visits";
import { findVendorByKey } from "@/lib/fixtures/vendors";
import { collectorResponse } from "@/lib/http";
import { oauthClientIp, oauthRateLimit } from "@/lib/oauth/ratelimit";
import { MAX_OBSERVE_BODY_BYTES, readBodyWithLimit } from "@/lib/telemetry/request-limits";
import { hostnameOf, normalizeDomain } from "@/lib/vendors/domain";
import { acceptedHosts } from "@/lib/vendors/hosts";

/** Per source IP. A vendor's server forwards every request it serves, so this is far above /v1/observe's. */
const AGENT_VISIT_IP_LIMIT_PER_MINUTE = 3000;
/** Per vendor key, once it resolves. Bounds one leaked key's write load. */
const AGENT_VISIT_VENDOR_LIMIT_PER_MINUTE = 6000;

/**
 * `POST /api/v1/agent-visit` — AI agents and crawlers reading a vendor's own
 * site. See src/lib/agents/visits.ts.
 *
 * Two body shapes:
 *
 *   server  { k, ua, ip?, path, host?, signature_agent? }
 *           From the vendor's own server, forwarding a request it served.
 *           `host` defaults to the vendor's verified domain.
 *   client  { k, path, client: true, webdriver? }
 *           From attest.js. The user-agent, address and Signature-Agent come
 *           from this request's own headers and the host from its Origin —
 *           nothing about the visitor is taken from the body.
 *
 * Always 204, like /v1/observe: the client mode runs inside a vendor's page,
 * and the server mode is fire-and-forget from inside the vendor's request
 * path. Neither may ever see a failure worth handling. `x-letterprove` says
 * whether it was counted.
 *
 * The key is the publishable one and is not a secret, so anyone holding it
 * can post here. What they can write is private analytics the vendor reads
 * about itself, never evidence — the same reason the rate limits, not the key,
 * are the backstop.
 */
export async function POST(request: Request) {
	if (!(await oauthRateLimit(`agent-visit:ip:${oauthClientIp(request)}`, 60, AGENT_VISIT_IP_LIMIT_PER_MINUTE))) {
		return collectorResponse(false);
	}

	const raw = await readBodyWithLimit(request, MAX_OBSERVE_BODY_BYTES);
	const body = raw === undefined ? null : parseJson(raw);
	if (!body || typeof body !== "object") return collectorResponse(false);
	const record = body as Record<string, unknown>;
	if (typeof record.k !== "string" || !record.k) return collectorResponse(false);

	const path = normalizePath(record.path);
	if (!path) return collectorResponse(false);

	const clientMode = record.client === true;
	const visit = clientMode
		? classifyVisit({
				userAgent: request.headers.get("user-agent"),
				signatureAgent: request.headers.get("signature-agent"),
				webdriver: record.webdriver === true,
			})
		: classifyVisit({
				userAgent: typeof record.ua === "string" ? record.ua : null,
				signatureAgent: typeof record.signature_agent === "string" ? record.signature_agent : null,
			});
	// A browser, or nothing recognisable. Not counted, and decided before any
	// database read, because this is most of what a vendor's server forwards.
	if (!visit) return collectorResponse(false);

	const vendor = await findVendorByKey(record.k);
	if (!vendor) return collectorResponse(false);
	if (!(await oauthRateLimit(`agent-visit:vendor:${vendor.slug}`, 60, AGENT_VISIT_VENDOR_LIMIT_PER_MINUTE))) {
		return collectorResponse(false);
	}
	// Same door as /v1/observe: nothing is collected for a domain nobody has
	// proven, so an impersonator accumulates nothing before the owner arrives.
	if (!vendor.domainVerified) return collectorResponse(false);

	const host = clientMode
		? hostnameOf(request.headers.get("origin"))
		: typeof record.host === "string" && record.host.trim()
			? normalizeDomain(record.host)
			: vendor.domain;
	if (!host) return collectorResponse(false);
	if (host !== vendor.domain && !(await acceptedHosts(vendor.id)).has(host)) return collectorResponse(false);

	const ip = clientMode ? clientIp(request.headers) : typeof record.ip === "string" && parseIp(record.ip.trim()) ? record.ip.trim() : null;

	// After the response, like proof-access recording (src/lib/access/log.ts):
	// verifying an address can mean fetching an operator's range list, and the
	// vendor's server is waiting on nothing but a 204.
	const write = () => recordAgentVisit(vendor.id, visit, path, ip).then(() => undefined);
	try {
		after(write);
	} catch {
		await write();
	}
	return collectorResponse(true);
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
