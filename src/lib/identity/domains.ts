/**
 * Is this domain a company?
 *
 * Every observation arrives keyed by the domain part of an account identity
 * (README § "The one hard rule: domain only"). Attribution assumes that domain
 * names a company — and for most rows it does. For the rest, assuming it
 * publishes something false and immutable.
 *
 * Three ways the assumption breaks, all of them already live in `hot_events`
 * within an hour of the first real install:
 *
 *   gmail.com          a person, not a company
 *   letterstory.com    us, dogfooding our own product
 *   probe.invalid      not a real domain at all
 *
 * The first would publish *"Gmail is a verified customer"*. The second is
 * worse in a quieter way: attesting that we use our own product is exactly the
 * vendor-asserted circularity this product exists to replace, and it would be
 * signed and chained like any other claim.
 *
 * **This function proposes; it never decides.** README § Identity resolution:
 * *"Inference proposes; the alias map decides."* Nothing here should create,
 * promote or publish a customer on its own — it exists so that the code which
 * does can refuse the obvious mistakes, and so an operator has a bucket to
 * look at rather than a silently wrong total.
 *
 * Deliberately NOT handled here: contractors and agencies — `someone@
 * consultancy.com` working inside Acme's tenant is a real company domain that
 * still shouldn't be attributed to Acme. No list can catch that; it needs a
 * human-correctable mapping, which is the alias map's job, not this one's.
 *
 * "internal" is relative to who's asking. The risk is self-dealing —
 * Letterprove attesting that Lettertrace is its own customer, with nobody
 * independent involved — not the domain in the abstract. A genuinely
 * external vendor with The Letter Company as a real, DNS-verified,
 * consent-linked customer is exactly the same relationship any other
 * customer has, so `classifyDomain` takes the asking vendor's own domain and
 * only refuses when that vendor is *also* one of ours. Omit it and the
 * check fails closed to the old, vendor-agnostic behavior.
 */

export type DomainKind =
	/** A real organisation. Eligible to become a customer, pending consent. */
	| "company"
	/** A person's mailbox. Never a customer, at any tier. */
	| "free_mail"
	/** The Letter Company itself. Real usage, but attesting it is self-dealing. */
	| "internal"
	/** Malformed, reserved, or otherwise not a usable identity. */
	| "unknown";

export interface DomainClass {
	kind: DomainKind;
	/** Written to be read by an operator staring at an unattributable bucket. */
	reason: string;
}

/**
 * Consumer mailbox providers. Not exhaustive and never will be — this is the
 * long tail by definition, which is why `classifyDomain` is a proposal rather
 * than an authority. Add to it as the bucket shows you what you're missing.
 */
const FREE_MAIL = new Set([
	"gmail.com",
	"googlemail.com",
	"outlook.com",
	"hotmail.com",
	"hotmail.co.uk",
	"live.com",
	"msn.com",
	"yahoo.com",
	"yahoo.co.uk",
	"ymail.com",
	"aol.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"proton.me",
	"protonmail.com",
	"pm.me",
	"gmx.com",
	"gmx.de",
	"web.de",
	"mail.com",
	"zoho.com",
	"yandex.ru",
	"qq.com",
	"163.com",
	"126.com",
	"naver.com",
	"hey.com",
	"fastmail.com",
	"tutanota.com",
	"tuta.io",
	"duck.com",
]);

/**
 * The Letter Company's own domains.
 *
 * Dogfooding puts these in the same table as real customers — Lettertrace runs
 * Letterprove, and its staff sign in like anyone else. Keep this current as
 * new products ship, because the failure is silent: an unlisted internal
 * domain simply reads as a customer.
 */
const INTERNAL = new Set([
	"letterstory.com",
	"letter.company",
	"lettertrace.com",
	"letterprove.com",
	"letterbrace.com",
	"letterseer.com",
	"letterchange.com",
	"letterpose.com",
	"phantomstory.com",
]);

/**
 * TLDs reserved by RFC 2606 / RFC 6761 for documentation and testing. Real
 * mail never originates from one, so anything arriving under them is a
 * fixture, a probe, or a bug — worth seeing, never worth attributing.
 */
const RESERVED_TLDS = new Set(["invalid", "test", "example", "localhost", "local"]);

/**
 * Normalise before matching. The wire value is whatever followed the `@`, so
 * it can carry case, surrounding whitespace, a trailing dot from a
 * fully-qualified name, or IDN unicode.
 */
function normalise(domain: string): string {
	let d = domain.trim().toLowerCase();
	while (d.endsWith(".")) d = d.slice(0, -1);
	return d;
}

export function classifyDomain(domain: string, vendorDomain?: string): DomainClass {
	const d = normalise(domain);

	if (!d) return { kind: "unknown", reason: "empty" };

	// A bare label ("localhost", "acme") is not a routable mail domain. This
	// also catches the localhost origin a developer's browser would send.
	if (!d.includes(".")) return { kind: "unknown", reason: `no dot in "${d}"` };

	if (d.includes(" ") || d.includes("@") || d.includes("/")) {
		return { kind: "unknown", reason: `malformed: "${d}"` };
	}

	// An IP literal is a valid mail destination and a useless identity — it
	// names a host, never an organisation.
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d) || d.startsWith("[")) {
		return { kind: "unknown", reason: `ip literal: "${d}"` };
	}

	const tld = d.slice(d.lastIndexOf(".") + 1);
	if (RESERVED_TLDS.has(tld)) {
		return { kind: "unknown", reason: `reserved tld ".${tld}" — fixture or probe, not a real identity` };
	}

	if (INTERNAL.has(d)) {
		// Self-dealing only exists when the vendor asking is also ours. No
		// vendorDomain (an unmigrated call site, or a passive read with no
		// vendor in scope) fails closed to the original, always-internal
		// behavior — an unknown asker is never treated as "safe".
		if (!vendorDomain || INTERNAL.has(normalise(vendorDomain))) {
			return {
				kind: "internal",
				reason: "The Letter Company's own domain — attesting our own usage is self-dealing",
			};
		}
		return {
			kind: "company",
			reason: "The Letter Company, verified as a genuine customer of a non-Letter-Company vendor",
		};
	}

	if (FREE_MAIL.has(d)) {
		return { kind: "free_mail", reason: "consumer mailbox provider — names a person, not a company" };
	}

	// Everything else is *proposed* as a company. This default is generous on
	// purpose: the alternative — defaulting to "unknown" — would bucket every
	// genuine customer and make the classifier useless. It is only safe
	// because nothing downstream may publish on this answer alone; a human
	// still has to create the customer record.
	return { kind: "company", reason: "not a known consumer or internal domain" };
}

/** Can this domain ever be attributed to a customer? Consent is a separate question. */
export function isAttributable(domain: string, vendorDomain?: string): boolean {
	return classifyDomain(domain, vendorDomain).kind === "company";
}

/**
 * Split a set of observed domains into the attributable ones and everything
 * else, keeping the reason for each exclusion.
 *
 * The excluded list is the point. Dropping unattributable domains silently
 * would understate real usage with no way to explain the gap; this keeps them
 * counted and inspectable while never letting them reach a published claim.
 */
export function partitionDomains(
	domains: Iterable<string>,
	vendorDomain?: string,
): {
	attributable: string[];
	excluded: { domain: string; kind: DomainKind; reason: string }[];
} {
	const attributable: string[] = [];
	const excluded: { domain: string; kind: DomainKind; reason: string }[] = [];

	for (const domain of domains) {
		const { kind, reason } = classifyDomain(domain, vendorDomain);
		if (kind === "company") attributable.push(domain);
		else excluded.push({ domain, kind, reason });
	}

	return { attributable, excluded };
}
