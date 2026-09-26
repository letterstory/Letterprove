/**
 * Proof-access logging.
 *
 * One structured line per proof fetch, to stdout — answers "is anything
 * reading our proofs" today via the platform's log drain, no storage
 * required.
 *
 * The line is prefixed so it can be grepped out of an otherwise noisy log:
 *
 *   [letterprove:access] {"subject":"vantage/acme-corp","kind":"ai_agent",...}
 *
 * NO IP, NO RAW USER-AGENT. The classification is kept; the string that
 * produced it is not. A proof endpoint is public and its readers are mostly
 * machines, but the same discipline applies here as everywhere else in this
 * repo — keep the fact, drop the identifier.
 *
 * A `kind === "ai_agent"` hit is also, since the 2026-09-26 usage-billing
 * feature, recorded durably (agentic_read_events — see
 * src/lib/billing/agentic-reads.ts) — the first real consumer of this
 * classification beyond the log line. Best-effort and fire-and-forget: a
 * billing write must never add latency to a public proof response or turn a
 * database hiccup into a broken proof, the same tolerance this file already
 * applies to the console line above.
 */

import { classify } from "./classify";
import { dbClient } from "@/lib/db/client";

const PREFIX = "[letterprove:access]";

export function logProofAccess(request: Request, subject: string): void {
	const { kind, name } = classify(request.headers.get("user-agent"));

	// Never let telemetry break a proof response.
	try {
		console.log(
			`${PREFIX} ${JSON.stringify({
				subject,
				kind,
				name,
				// Which answer engine sent a person here, when one did. Host only —
				// a full referrer can carry a conversation id or a search query.
				from: refererHost(request.headers.get("referer")),
			})}`
		);
	} catch {
		/* ignore */
	}

	if (kind === "ai_agent") recordAgenticRead(subject, name);
}

/**
 * Every proof/attest route passes a subject with the vendor slug first
 * ("vendor", "vendor/customer", "vendor/aggregate/chain", ...) — see the
 * route files under src/app/attest and src/app/api/proofs.
 */
function recordAgenticRead(subject: string, agentName: string): void {
	const db = dbClient();
	if (!db) return;

	const vendorSlug = subject.split("/")[0];
	void (async () => {
		try {
			const { error } = await db
				.from("agentic_read_events")
				.insert({ vendor_slug: vendorSlug, subject, agent_name: agentName });
			if (error) console.error(`${PREFIX} agentic read record failed`, error.message);
		} catch (error) {
			console.error(`${PREFIX} agentic read record failed`, error instanceof Error ? error.message : String(error));
		}
	})();
}

function refererHost(referer: string | null): string {
	if (!referer) return "";
	try {
		return new URL(referer).hostname.toLowerCase();
	} catch {
		return "";
	}
}
