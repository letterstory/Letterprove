/**
 * Proof-access logging.
 *
 * One structured line per proof fetch, to stdout. Deliberately not a database:
 * this repo has no data layer yet, and a line the platform's log drain already
 * captures answers "is anything reading our proofs" today without inventing
 * storage we would have to migrate later.
 *
 * The line is prefixed so it can be grepped out of an otherwise noisy log:
 *
 *   [letterprove:access] {"subject":"vantage/acme-corp","kind":"ai_agent",...}
 *
 * NO IP, NO RAW USER-AGENT. The classification is kept; the string that
 * produced it is not. A proof endpoint is public and its readers are mostly
 * machines, but the same discipline applies here as everywhere else in this
 * repo — keep the fact, drop the identifier.
 */

import { classify } from "./classify";

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
}

function refererHost(referer: string | null): string {
	if (!referer) return "";
	try {
		return new URL(referer).hostname.toLowerCase();
	} catch {
		return "";
	}
}
