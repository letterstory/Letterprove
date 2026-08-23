# Security

Letterprove publishes signed claims that other people rely on, so a bug that
lets a claim say something untrue matters as much as one that leaks data.
Both are in scope.

## Reporting

Email **support@letterbrace.com** with the details and a way to reproduce.
Please do not open a public issue for anything exploitable — we will confirm
receipt and agree a disclosure timeline with you.

## What we consider a vulnerability

Alongside the obvious (authentication bypass, data exposure, injection), the
following are in scope because they attack what the product asserts rather
than the system that runs it:

- Making a published attestation claim something that was not observed.
- Getting an attestation signed for a domain you do not control.
- Reading another vendor's customer list, telemetry, or Stripe credential.
- Causing an attestation chain to verify against a document it does not match.

## Known and accepted limits

These are design boundaries, documented in the README's trust model rather
than defects — a report describing one of them is welcome but will not be
treated as a vulnerability:

- **A vendor can fabricate their own telemetry.** The collector pins events to
  the vendor's `Origin` and refuses unverified domains, but `Origin` binds a
  browser and not `curl`. That is why every claim carries a provenance tier:
  tiers 1–2 are vendor-originated and labelled as such. Fraud scoring raises
  the cost; it does not make it impossible.
- **Publishable keys are not secrets.** They ship in vendor page HTML by
  design. Access is controlled by domain verification, not key secrecy.
- **Tier 3 depends on Stripe.** A vendor who defrauds their own Stripe account
  could corroborate a false claim.

## Cryptography

Attestations are Ed25519-signed over RFC 8785-style canonical JSON and chained
by `prev_hash`. The verifier in `scripts/verify.mjs` re-implements
canonicalisation rather than importing ours, so agreement between them is
meaningful. If you find a case where our bytes and an independent
implementation's differ, that is a vulnerability — report it.
