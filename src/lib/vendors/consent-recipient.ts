/**
 * Who is allowed to receive a consent link.
 *
 * This is the whole of the tier-4 binding, so it is worth stating plainly:
 * a counter-signature is only evidence if the person approving is actually at
 * the customer. Before this, the vendor received the link and we trusted them
 * to forward it. This module is the rule that replaces that trust — the link
 * goes to an address on the customer's own domain, and nowhere else.
 *
 * Exact domain OR a subdomain of it. Subdomains are allowed because
 * `jane@mail.acme.com` requires control of acme.com's DNS just as much as
 * `jane@acme.com` does — it is the customer's namespace either way, so
 * refusing it would cost real vendors a support round-trip and buy nothing.
 * A *sibling* domain (`acme.co.uk` for a customer on `acme.com`) is refused:
 * it looks equivalent to a human and is a completely different registration,
 * which is exactly the substitution this check exists to catch.
 */

/** The domain part of an email address, lowercased, or null if it isn't one. */
export function domainOfEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = value.trim();
	if (!email || /\s/.test(email)) return null;

	// Exactly one "@" — `a@b@c.com` is not an address we should guess about.
	const parts = email.split("@");
	if (parts.length !== 2) return null;

	const [local, domain] = parts;
	if (!local) return null;

	const host = domain.toLowerCase();
	// Must look like a real registrable host. No trailing dot, no empty labels.
	if (!host.includes(".") || host.startsWith(".") || host.endsWith(".") || host.includes("..")) return null;
	if (!/^[a-z0-9.-]+$/.test(host)) return null;

	return host;
}

export type RecipientCheck = { ok: true; email: string } | { ok: false; error: string };

/**
 * `customerDomain` is the domain already stored on the customer row — the same
 * value published in the attestation and used to match telemetry. Checking
 * against that, rather than against anything supplied in this request, is what
 * stops a vendor from naming both sides of the comparison.
 */
export function checkConsentRecipient(input: unknown, customerDomain: string): RecipientCheck {
	const raw = typeof input === "string" ? input.trim() : "";
	if (!raw) return { ok: false, error: "A contact email at the customer is required." };

	const emailDomain = domainOfEmail(raw);
	if (!emailDomain) return { ok: false, error: `"${raw}" isn't a valid email address.` };

	const expected = customerDomain.trim().toLowerCase();
	if (!expected) return { ok: false, error: "This customer has no domain set, so consent can't be requested." };

	const matches = emailDomain === expected || emailDomain.endsWith(`.${expected}`);
	if (!matches) {
		return {
			ok: false,
			error:
				`The consent link can only be sent to an address at ${expected}. ` +
				`"${raw}" is on ${emailDomain}. This is what makes a counter-signature mean anything — ` +
				`it has to reach the customer, not you.`,
		};
	}

	return { ok: true, email: raw };
}
