/**
 * Canonical JSON — the bytes that get hashed and signed.
 *
 * A signature is over BYTES, not over a JavaScript object, so the producer and
 * every independent verifier have to agree character-for-character on how a
 * document serialises. `JSON.stringify` does not give that guarantee: key order
 * follows insertion order, so adding a field in a different place in the code
 * silently changes the bytes and invalidates every prior signature.
 *
 * This is the JCS (RFC 8785) subset our schema needs: object keys sorted by
 * code unit, no insignificant whitespace, arrays left in document order because
 * their order is meaningful (`features` is a list, not a set).
 *
 * DELIBERATE LIMITATION: numbers are serialised by `JSON.stringify`, which is
 * correct for the integers our schema uses and NOT full RFC 8785 for floats.
 * Every numeric field in AttestationBody is a count. If a ratio is ever
 * published (an ROI multiple, an adoption percentage), it must be carried as a
 * string or scaled to an integer — do not weaken this function to accept it.
 */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function canonicalize(value: unknown): string {
	return stringify(value as Json);
}

function stringify(value: Json): string {
	if (value === null || typeof value === "boolean") return JSON.stringify(value);

	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`cannot canonicalize non-finite number: ${value}`);
		if (!Number.isInteger(value)) {
			throw new Error(
				`cannot canonicalize non-integer ${value} — carry ratios as strings or scaled integers`
			);
		}
		return JSON.stringify(value);
	}

	if (typeof value === "string") return JSON.stringify(value);

	if (Array.isArray(value)) return `[${value.map(stringify).join(",")}]`;

	if (typeof value === "object") {
		const keys = Object.keys(value).sort();
		const parts = keys.map((k) => `${JSON.stringify(k)}:${stringify(value[k])}`);
		return `{${parts.join(",")}}`;
	}

	throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

/** The bytes a signature actually covers. */
export function canonicalBytes(value: unknown): Buffer {
	return Buffer.from(canonicalize(value), "utf8");
}
