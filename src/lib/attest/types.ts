/**
 * The published attestation — the only thing an evaluating agent ever reads.
 *
 * Field order in this interface is irrelevant to the wire format: everything is
 * canonicalised (see canonical.ts) before it is hashed or signed, so two
 * services that agree on the values agree on the bytes.
 */

/** How much weight a claim has earned. See the trust model in the README. */
export type Tier = 0 | 1 | 2 | 3 | 4;

/** The unsigned body. Every field here is covered by the signature. */
export interface AttestationBody {
	/** Slug of the vendor who installed Letterprove. */
	vendor: string;
	/** Slug of the vendor's customer this attestation is about. */
	customer: string;
	/** Display name of that customer. */
	customer_name: string;
	/**
	 * VENDOR-ASSERTED. The company domain this claim is joined on, and the only
	 * field a reader can use to tell "Acme Corp" the customer from "Acme Corp"
	 * the lookalike.
	 *
	 * Every other field describes the claim; this one identifies its subject.
	 * The domain is what telemetry joins on, and what a consent link's
	 * recipient had to hold a mailbox at, so it is what a tier-4
	 * counter-signature is actually bound to. The vendor picks it freely (any
	 * domain that is not free-mail, one of ours, or a reserved TLD), so
	 * publishing the name without it meant a vendor could register acme-hq.com,
	 * name the row "Acme Corp", approve their own consent link, and publish
	 * tier 4 with nothing in the document a reader could notice the
	 * substitution in. Self-approving on a domain you control is an accepted
	 * trade (README, "Why delivery is the binding"); doing it invisibly is not.
	 *
	 * Added 2026-09-10. Snapshots frozen before then do not carry it, which is
	 * why the field is additive rather than versioned: the signature covers
	 * whatever fields a body had, so old entries still verify unchanged.
	 */
	customer_domain: string;
	/**
	 * True only when the evidence supports it at the stated tier. This word is
	 * the product's whole credibility; never set it from vendor assertion alone.
	 */
	verified: boolean;
	tier: Tier;
	/**
	 * VENDOR-ASSERTED, `YYYY-MM`. Copied from the customer record the vendor
	 * maintains, not derived from the event stream. Nothing here observes a
	 * first-activity date, so do not read it as one.
	 */
	since: string;
	/**
	 * VENDOR-ASSERTED. Named feature events are a phase-2 addition and are not
	 * wired: `/api/v1/config` serves an empty `signals` registry and `ev` is a
	 * closed enum of session/signup/login, so nothing observes feature use
	 * today. These are the strings the vendor put on the customer record.
	 */
	features: string[];
	/** MEASURED. Sum of hourly rollups for this domain over the trailing 30 days. */
	sessions_30d: number;
	/**
	 * ALWAYS 0 TODAY. Phase-1 events carry no per-user dimension, so there is
	 * nothing honest to sum (rollup/snapshots.ts, decision 2026-08-12). Signed
	 * as a literal zero rather than omitted because the field is required and
	 * covered by the signature; read it as "not yet measured", never as a
	 * measurement of zero.
	 */
	seats_active: number;
	/**
	 * Payment corroborated by Stripe, present ONLY at tier 3. Absent rather
	 * than zero for everyone else — a zero would assert "pays nothing", where
	 * absence correctly says "we hold no payment evidence".
	 *
	 * Minor units, always an integer: canonical.ts serialises numbers with
	 * JSON.stringify and is explicitly not float-safe, so a fractional amount
	 * would break byte agreement with an independent verifier.
	 */
	contract_currency?: string;
	contract_monthly?: number;
	/** Earliest active subscription start, ISO. */
	contract_since?: string;
	/** End of the observation window this snapshot summarises. */
	observed_through: string;
	/** When this snapshot was cut. Distinct from observed_through on purpose. */
	published_at: string;
	/** Seconds an agent may cache this before re-fetching. */
	ttl: number;
	/**
	 * SHA-256 of the previous signed snapshot for this customer, hex. The
	 * genesis snapshot uses 64 zeroes. This is what makes history auditable
	 * rather than merely signed.
	 */
	prev_hash: string;
	/**
	 * Commit-pinned link to the open-source logic that computed these numbers.
	 * An agent can read exactly how the count was reached; nothing else in the
	 * document asks to be trusted.
	 */
	method: string;
}

/**
 * What actually gets published.
 *
 * Letterprove computes the body; the signer adds `key_id` and `signature`.
 * The split mirrors the service boundary: this repo can produce everything
 * above, and nothing below.
 */
export interface SignedAttestation extends AttestationBody {
	/** Which key signed it — see keys.ts. Rotation is additive. */
	key_id: string;
	/** Ed25519 over the canonical form of every other field, base64url. */
	signature: string;
}

/** Public key material, JWK form, as served at the JWKS endpoint. */
export interface PublicJwk {
	kty: "OKP";
	crv: "Ed25519";
	x: string;
	kid: string;
	alg: "EdDSA";
	use: "sig";
}

export interface Jwks {
	keys: PublicJwk[];
}

/** Why a verification failed, or that it didn't. */
export interface VerifyResult {
	ok: boolean;
	/** Present when ok is false. Written to be read by a human in a terminal. */
	reason?: string;
}
