import { promises as dns } from "node:dns";

/**
 * DNS proof that a vendor controls the domain they claim.
 *
 * Why this exists at all: origin-pinning stops a browser lying about where a
 * page was served from, because `Origin` is a forbidden header name that page
 * script cannot override. It does nothing about curl. /v1/observe's own
 * comment says as much. So without domain control, "we observed events from
 * acme.com" means only "someone sent us events claiming to be acme.com", and
 * the publishable key can't close the gap — it ships in the page HTML by
 * design.
 *
 * DNS rather than a file at a well-known path: a TXT record proves control of
 * the *domain*, where a file proves control of one path on one host serving
 * it. Shared hosting, a CDN with a permissive origin, or any user-content path
 * that reflects uploads can produce the second without the first.
 */

/** Prefix so the record is self-describing sitting in someone's DNS. */
export const TXT_PREFIX = "letterprove-site-verification";

/**
 * Where we look. `_letterprove.<domain>` is the primary — the `_name`
 * convention (_dmarc, _acme-challenge) keeps apex TXT uncluttered and clear
 * of its size limits. The apex is accepted too, because that is where people
 * expect site-verification records to go and refusing it would cost real
 * vendors a support round-trip for nothing.
 */
export function verificationHosts(domain: string): string[] {
	return [`_letterprove.${domain}`, domain];
}

/** The exact string a vendor pastes into their DNS. */
export function expectedRecord(token: string): string {
	return `${TXT_PREFIX}=${token}`;
}

export type VerificationOutcome =
	| { verified: true; host: string }
	| { verified: false; reason: "no-records" | "no-match" | "lookup-failed"; found: string[] };

/** Injectable so tests never touch the network. */
export type TxtResolver = (host: string) => Promise<string[][]>;

const resolveTxt: TxtResolver = (host) => dns.resolveTxt(host);

/**
 * Look for the expected record on any accepted host.
 *
 * A TXT record arrives as an array of strings that the resolver has already
 * split on 255-byte boundaries; they must be joined before comparing or a long
 * record silently never matches.
 */
export async function checkDomainVerification(
	domain: string,
	token: string,
	resolver: TxtResolver = resolveTxt,
): Promise<VerificationOutcome> {
	const expected = expectedRecord(token);
	const found: string[] = [];
	let anyLookupSucceeded = false;

	for (const host of verificationHosts(domain)) {
		let records: string[][];
		try {
			records = await resolver(host);
			anyLookupSucceeded = true;
		} catch {
			// NXDOMAIN on `_letterprove.<domain>` is the normal case before the
			// record is added, so a failed lookup on one host is not a failed
			// verification — keep checking the others.
			continue;
		}

		for (const chunks of records) {
			const value = chunks.join("").trim();
			found.push(value);
			if (value === expected) return { verified: true, host };
		}
	}

	if (!anyLookupSucceeded) return { verified: false, reason: "lookup-failed", found };
	if (found.length === 0) return { verified: false, reason: "no-records", found };
	return { verified: false, reason: "no-match", found };
}

/** What to tell the vendor, in terms of the thing they need to change. */
export function verificationMessage(outcome: VerificationOutcome, domain: string): string {
	if (outcome.verified) return `Verified via ${outcome.host}.`;
	switch (outcome.reason) {
		case "lookup-failed":
			return `Couldn't reach DNS for ${domain}. If you just added the record, give it a few minutes and try again.`;
		case "no-records":
			return `No TXT record found at _letterprove.${domain} or ${domain} yet. DNS changes can take a few minutes to propagate.`;
		case "no-match":
			return `Found TXT records for ${domain}, but none matched. Check the value was pasted whole, including the letterprove-site-verification= prefix.`;
	}
}
