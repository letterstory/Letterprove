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
	 * True only when the evidence supports it at the stated tier. This word is
	 * the product's whole credibility; never set it from vendor assertion alone.
	 */
	verified: boolean;
	tier: Tier;
	/** First observed activity, `YYYY-MM`. */
	since: string;
	/** Features observed in active use. */
	features: string[];
	sessions_30d: number;
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
