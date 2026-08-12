/**
 * Observation logging.
 *
 * One structured line per accepted event, to stdout — the same interim
 * pattern access/log.ts uses for proof reads: this repo has no data layer
 * yet, and the real rollup replaces fixtures.ts wholesale rather than
 * building alongside it (see that file's header comment). Until it lands,
 * a line the platform's log drain already captures is what "is anything
 * reporting" runs against.
 *
 *   [letterprove:observe] {"vendor":"vantage","ev":"session",...}
 *
 * Bound to facts the client did not supply, per the Event schema decision:
 * `receipt_ts` (server time), not the client's untrusted `ts`; and the
 * request origin. ASN is deliberately NOT captured here — it needs a
 * GeoIP/ASN lookup this deploy doesn't have wired, and faking it would be
 * worse than omitting it. Fraud scoring in Letterstory can't key off ASN
 * concentration until that lands for real.
 */

import type { EventType } from "./events";

const PREFIX = "[letterprove:observe]";

export function logObservation(params: {
	vendor: string;
	domain: string;
	ev: EventType;
	cfg: number;
	origin: string;
}): void {
	// Never let telemetry break collection.
	try {
		console.log(
			`${PREFIX} ${JSON.stringify({
				vendor: params.vendor,
				domain: params.domain,
				ev: params.ev,
				cfg: params.cfg,
				origin: params.origin,
				receipt_ts: Math.floor(Date.now() / 1000),
			})}`
		);
	} catch {
		/* ignore */
	}
}
