#!/usr/bin/env node
/**
 * Mint an Ed25519 signing key.
 *
 * Prints a seed for the environment and the public JWK. The private half is
 * written to stdout and nowhere else — it is not saved to disk, because a key
 * file in a repo checkout is a key file that eventually gets committed.
 *
 *   node scripts/keygen.mjs
 *
 * Rotation is additive. When replacing a key, move the OLD public JWK into
 * LETTERPROVE_RETIRED_JWKS before switching the new one in, or every proof
 * signed by it stops verifying.
 */

import { createHash, createPublicKey, createPrivateKey, randomBytes } from "node:crypto";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const seed = randomBytes(32);
const privateKey = createPrivateKey({
	key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
	format: "der",
	type: "pkcs8",
});
const { x } = createPublicKey(privateKey).export({ format: "jwk" });
const kid = `lp-${createHash("sha256").update(x).digest("hex").slice(0, 10)}`;

console.log(`
  Private seed — set this on the SIGNER only, never in this repo:

    LETTERPROVE_SIGNING_KEY=${seed.toString("base64")}

  Public JWK — publish it, and keep publishing it after the key retires:

    ${JSON.stringify({ kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" })}

  Key id: ${kid}
`);
