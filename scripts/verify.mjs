#!/usr/bin/env node
/**
 * Independent verifier for Letterprove attestations.
 *
 *   npm run verify -- http://localhost:9100/attest/vantage/acme-corp.json
 *   npm run verify -- http://localhost:9100/attest/vantage/acme-corp/chain
 *   npm run verify -- ./snapshot.json --jwks http://localhost:9100/.well-known/letterprove-jwks.json
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

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
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

/** Default to the JWKS on the same origin as the proof. */
function defaultJwksUrl(target) {
	if (!/^https?:\/\//.test(target)) return null;
	return new URL("/.well-known/letterprove-jwks.json", target).toString();
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

// --------------------------------------------------------------------- main

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const jwksFlag = args.indexOf("--jwks");
const jwksTarget = jwksFlag >= 0 ? args[jwksFlag + 1] : defaultJwksUrl(target);

if (!target || !jwksTarget) {
	console.error("usage: verify <proof-url|file> [--jwks <url|file>]");
	process.exit(2);
}

const [doc, jwks] = await Promise.all([load(target), load(jwksTarget)]);
const chain = Array.isArray(doc) ? doc : Array.isArray(doc?.chain) ? doc.chain : [doc];

console.log(`\n  ${target}`);
console.log(`  keys from ${jwksTarget}\n`);

let failures = 0;
let expectedPrev = GENESIS;

for (const snapshot of chain) {
	const label = `${snapshot.customer ?? "?"} @ ${snapshot.observed_through ?? "?"}`;
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
if (head?.method) console.log(`\n  method: ${head.method}`);
if (jwks.keys.some((k) => String(k.kid).startsWith("dev-insecure"))) {
	console.log("\n  ⚠ signed with a development key — this is a demonstration, not evidence");
}

console.log(
	failures === 0
		? `\n  ${chain.length} attestation${chain.length === 1 ? "" : "s"} verified\n`
		: `\n  ${failures} of ${chain.length} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
