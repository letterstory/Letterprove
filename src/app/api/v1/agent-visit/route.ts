import { after } from "next/server";
import { clientIp, parseIp } from "@/lib/access/verify-agent";
import { classifyVisit, normalizePath, recordAgentVisit } from "@/lib/agents/visits";
import { findVendorByKey } from "@/lib/fixtures/vendors";
import { collectorResponse } from "@/lib/http";
import { oauthClientIp, oauthRateLimit } from "@/lib/oauth/ratelimit";
import { MAX_OBSERVE_BODY_BYTES, readBodyWithLimit } from "@/lib/telemetry/request-limits";
import { hostnameOf, normalizeDomain } from "@/lib/vendors/domain";
import { acceptedHosts, isOriginAccepted } from "@/lib/vendors/hosts";
import { collectorModules, recordServerSeen } from "@/lib/vendors/script";

/** Keys whose server snippet this instance has already stamped as seen. */
const serverSeenKeys = new Set<string>();

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
 *           From visit.js (or, on the legacy path, attest.js). The user-agent,
 *           address and Signature-Agent come from this request's own headers
 *           and the host from its Origin — nothing about the visitor is taken
 *           from the body.
 *
 * Both modes also arrive proxied, from lettervisit.com/api/v1/agent-visit (a
 * rewrite to here; src/lib/vendors/install.ts VISITORS_ORIGIN). The rewrite
 * passes Origin, User-Agent and Signature-Agent through untouched; the address
 * is read proxy-aware by clientIp, and the per-IP limit keys on the first
 * x-forwarded-for hop (oauthClientIp), so one proxy does not share one bucket.
 * The response's `access-control-allow-origin: *` covers vendor pages calling
 * lettervisit.com as it does this origin.
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
	// The first forward of ANY kind proves the server snippet is installed, so
	// the app can say so before an agent ever visits. One vendor lookup per key
	// per instance; after that a browser costs nothing again.
	if (!clientMode && !serverSeenKeys.has(record.k)) {
		serverSeenKeys.add(record.k);
		const seen = await findVendorByKey(record.k);
		if (seen?.id) await recordServerSeen(seen.id);
	}

	// A browser, or nothing recognisable. Not counted, and decided before any
	// further database read, because this is most of what a vendor's server forwards.
	if (!visit) return collectorResponse(false);

	const vendor = await findVendorByKey(record.k);
	if (!vendor) return collectorResponse(false);
	// The vendor turned agent visitors off in its script (src/lib/vendors/script.ts).
	if (!(await collectorModules(vendor.id)).agent_visitors) return collectorResponse(false);
	if (!(await oauthRateLimit(`agent-visit:vendor:${vendor.slug}`, 60, AGENT_VISIT_VENDOR_LIMIT_PER_MINUTE))) {
		return collectorResponse(false);
	}
	const host = clientMode
		? hostnameOf(request.headers.get("origin"))
		: typeof record.host === "string" && record.host.trim()
			? normalizeDomain(record.host)
			: vendor.domain;
	if (!host) return collectorResponse(false);
	// Before DNS proof, agent visits are still counted, but only for the
	// vendor's own domain and hosts beneath it. Unlike /v1/observe this is
	// private analytics the vendor reads about itself and never evidence: it
	// reaches no attestation, so there is no claim an impersonator could build
	// up before the owner arrives, and a new vendor sees agents on day one
	// instead of after a DNS change. Once verified, the usual rule applies: the
	// verified domain, hosts beneath it, and explicitly proven hosts.
	const accepted = vendor.domainVerified ? await acceptedHosts(vendor.id) : new Set<string>();
	if (!isOriginAccepted(host, vendor.domain, accepted)) return collectorResponse(false);

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
