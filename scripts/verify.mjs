#!/usr/bin/env node
/**
 * Independent verifier for Letterprove attestations.
 *
 *   npm run verify -- https://app.letterprove.com/attest/{vendor}/chain
 *   npm run verify -- ./snapshot.json
 *   npm run verify -- ./snapshot.json --jwks ./jwks.json      (a copy you already hold)
 *   npm run verify -- ./dev-snapshot.json --allow-dev         (local testing only)
 *
 * Keys always come from app.letterprove.com unless --jwks says otherwise —
 * NEVER from the host that served the document. A vendor's proof can be
 * served from the vendor's own domain (proof.acme.com), and whoever controls
 * that hostname could serve a forged document with its own keys beside it.
 *
 * This file deliberately shares NO code with the service. It re-implements
 * canonicalisation and signature checking from the published description, using
 * only Node built-ins, because a verifier that imports the producer's own
 * canonicaliser cannot detect the one bug that matters — the producer and the
 * spec disagreeing. Agreement between two independent implementations is the
 * only agreement worth anything here.
 *
 * It is also the artifact a sceptical third party should be able to run without
 * trusting us, so it stays dependency-free and short enough to read.
 */

import { createHash, createPrivateKey, createPublicKey, verify as edVerify } from "node:crypto";
import { readFile } from "node:fs/promises";

const GENESIS = "0".repeat(64);

// ---------------------------------------------------------------- canonical

/** RFC 8785 subset: sorted object keys, array order preserved, integers only. */
function canonicalize(value) {
	if (value === null || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isInteger(value)) throw new Error(`non-integer number: ${value}`);
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
			.join(",")}}`;
	}
	throw new Error(`cannot canonicalize ${typeof value}`);
}

// ------------------------------------------------------------------ loading

async function load(target) {
	if (/^https?:\/\//.test(target)) {
		const res = await fetch(target, { headers: { accept: "application/json" } });
		if (!res.ok) throw new Error(`${target} → HTTP ${res.status}`);
		return res.json();
	}
	return JSON.parse(await readFile(target, "utf8"));
}

/** The only key set this verifier trusts by default, wherever the document came from. */
const CANONICAL_JWKS = "https://app.letterprove.com/.well-known/letterprove-jwks.json";

/**
 * The development key's public half, derived here from its published seed
 * rather than recognised by key id. A forger chooses the key id; it cannot
 * choose which key the published seed produces.
 */
function devPublicX() {
	const seed = createHash("sha256").update("letterprove-development-key-do-not-trust").digest();
	const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
	const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
	return createPublicKey(priv).export({ format: "jwk" }).x;
}

// ------------------------------------------------------------- verification

function verifyOne(signed, jwks) {
	const { signature, ...body } = signed;
	if (!signature) return "no signature";

	const jwk = jwks.keys.find((k) => k.kid === signed.key_id);
	if (!jwk) return `no published key with id "${signed.key_id}"`;

	const ok = edVerify(
		null,
		Buffer.from(canonicalize(body), "utf8"),
		createPublicKey({ key: jwk, format: "jwk" }),
		Buffer.from(signature, "base64url")
	);
	return ok ? null : "signature does not match the document";
}

function hashOf(signed) {
	return createHash("sha256").update(canonicalize(signed), "utf8").digest("hex");
}

// ----------------------------------------------------------------- reporting

/**
 * What the document is a claim ABOUT.
 *
 * A per-customer attestation names its customer. The vendor-level aggregate
 * deliberately does not — it reports `companies_observed`, never "customers",
 * because counting a company is not the same as claiming it as a customer — so
 * reading `customer` alone prints "?" for the one claim most vendors publish.
 */
function subjectOf(snapshot) {
	if (snapshot.customer) return snapshot.customer;
	if (snapshot.kind === "aggregate") return `${snapshot.vendor ?? "?"} (aggregate)`;
	return "?";
}

/**
 * Name AND domain, together, because neither alone identifies anybody.
 *
 * Both are chosen by the vendor and nothing ties one to the other, so a
 * display name on its own is worth exactly as much as a logo on a wall. The
 * domain is the field the evidence is actually joined on: telemetry arrives
 * under it, and Stripe evidence is matched on it. Printing the name without it would let "Acme Corp" on acme-hq.com
 * read identically to "Acme Corp" on acme.com.
 *
 * Older snapshots predate the field. Saying so beats printing a blank, which
 * would look like a claim about an empty domain.
 */
function identityOf(snapshot) {
	if (!snapshot.customer_name && !snapshot.customer_domain) return null;
	const name = snapshot.customer_name ?? snapshot.customer ?? "?";
	const domain = snapshot.customer_domain ?? "domain not stated (snapshot predates the field)";
	return `${name} @ ${domain}`;
}

/**
 * Provenance tiers, restated here from the published description rather than
 * imported — same reason this file re-implements canonicalisation. A verifier
 * that took its definitions from the producer could not report a disagreement
 * between the producer and the spec.
 *
 * The tier is the entire provenance claim: a valid signature over a tier-0 body
 * proves only that the vendor said so. Reporting "verified" without it invites
 * exactly the reading the tiers exist to prevent.
 */
const TIERS = {
	0: "vendor-asserted",
	1: "script-observed",
	2: "infrastructure-bound",
	3: "third-party confirmed",
	4: "customer counter-signed (retired)",
};

function tierOf(snapshot) {
	const t = snapshot.tier;
	if (!Number.isInteger(t)) return "no tier stated";
	return `tier ${t} — ${TIERS[t] ?? "unrecognised"}`;
}

// --------------------------------------------------------------------- main

const args = process.argv.slice(2);
const jwksFlag = args.indexOf("--jwks");
const allowDev = args.includes("--allow-dev");
const target = args.find((a, i) => !a.startsWith("--") && (jwksFlag < 0 || i !== jwksFlag + 1));
const jwksTarget = jwksFlag >= 0 ? args[jwksFlag + 1] : CANONICAL_JWKS;

if (!target || !jwksTarget) {
	console.error("usage: verify <proof-url|file> [--jwks <url|file>] [--allow-dev]");
	process.exit(2);
}

if (jwksTarget !== CANONICAL_JWKS) {
	console.error(
		`\n  ⚠ KEYS NOT FROM app.letterprove.com: ${jwksTarget}\n` +
			"    A passing result proves only that these documents match THESE keys. Trust it only if\n" +
			`    you fetched the keys from ${CANONICAL_JWKS} yourself.\n`
	);
}

const [doc, jwks] = await Promise.all([load(target), load(jwksTarget)]);
const chain = Array.isArray(doc) ? doc : Array.isArray(doc?.chain) ? doc.chain : [doc];

console.log(`\n  ${target}`);
console.log(`  keys from ${jwksTarget}\n`);

let failures = 0;
let expectedPrev = GENESIS;

for (const snapshot of chain) {
	const label = `${subjectOf(snapshot)} @ ${snapshot.observed_through ?? "?"}`;
	const sigError = verifyOne(snapshot, jwks);

	// A single attestation is a window into a chain, not the whole of one, so its
	// prev_hash has nothing to be checked against. Only verify links when we were
	// given the history.
	const linkError =
		chain.length > 1 && snapshot.prev_hash !== expectedPrev
			? `prev_hash ${String(snapshot.prev_hash).slice(0, 12)}… ≠ ${expectedPrev.slice(0, 12)}…`
			: null;

	const error = sigError ?? linkError;
	if (error) failures++;
	console.log(`  ${error ? "✗" : "✓"} ${label}${error ? `  — ${error}` : ""}`);
	expectedPrev = hashOf(snapshot);
}

const head = chain.at(-1);

// A signature only ever proves the body was not altered. WHAT the body claims
// about how it was observed is the tier, and a verifier that prints "verified"
// without it lets a tier-0 vendor assertion read exactly like a tier-3
// Stripe-confirmed one. Taken from the head: it is the current claim, and tiers
// can legitimately rise over a chain's life as evidence improves.
if (head) console.log(`\n  provenance: ${tierOf(head)}`);

const identity = head && identityOf(head);
if (identity) console.log(`  subject: ${identity}`);

// Tier 4 (an emailed customer counter-signature) was retired on 2026-10-12.
// Old documents can still carry it; it proved only that a mailbox on the
// domain above approved the claim, which is worth nothing when the vendor
// controls that domain.
if (head?.tier === 4) {
	console.log("  ↳ tier 4 is retired and no longer issued. It was bound to that DOMAIN, not to the name; read it no higher than tier 3.");
}

if (head?.method) console.log(`  method: ${head.method}`);

// Judge the key that actually SIGNED these documents, not whatever the
// endpoint happens to publish. A JWKS carrying both a dev and a production key
// — which is exactly what a rotation looks like — would otherwise stamp
// "demonstration" on genuine countersigned proof. That mislabeling shipped
// once already, on 2026-08-13, in the service itself.
//
// Matched on key MATERIAL as well as id: the id is chosen by whoever signed,
// so a forger signing with the published dev seed under an "lp-" id would
// otherwise pass as production.
const DEV_X = devPublicX();
const signedByDev = chain.some((s) => {
	const kid = String(s.key_id);
	const jwk = jwks.keys?.find((k) => k.kid === kid);
	return kid.startsWith("dev-insecure") || jwk?.x === DEV_X;
});
if (signedByDev) {
	console.log("\n  ⚠ signed with the published development key — this is a demonstration, not evidence; anyone can produce this signature.");
	if (!allowDev) {
		console.log("\n  REJECTED (pass --allow-dev to accept development documents for local testing)\n");
		process.exit(3);
	}
}

console.log(
	failures === 0
		? `\n  ${chain.length} attestation${chain.length === 1 ? "" : "s"} verified\n`
		: `\n  ${failures} of ${chain.length} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
