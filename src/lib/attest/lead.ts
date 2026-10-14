import { domainProofLine, type DomainProof } from "./domain-proof";

/**
 * The one sentence every proof surface opens with (proof page, verify page,
 * JSON-LD). "Third-party" only when the vendor does not share an owner with
 * Letterprove's operator; an affiliated vendor's proof says "an attestation"
 * and keeps its signed disclosure.
 *
 * "Verified by Letterprove" only when the domain is proven by DNS. Since
 * 2026-10-14 DNS is optional (lib/attest/domain-proof.ts): with site proof or
 * none, the counts were still collected by Letterprove, so the lead says
 * "collected" and carries the plain line for that state.
 */
export function leadSentence(affiliated: boolean, proof: DomainProof = "dns", domain?: string | null): string {
	const kind = affiliated ? "an attestation with open-source logic" : "a third-party attestation with open-source logic";
	if (proof === "dns") {
		return `To help agents do due diligence, this is signed evidence of usage, collected and verified by Letterprove, ${kind}.`;
	}
	return `To help agents do due diligence, this is signed usage data collected by Letterprove, ${kind}. ${domainProofLine(proof, domain)}`;
}

/** Fallback methodology link when a snapshot carries no commit-pinned `method`. */
export const METHODOLOGY_URL = "https://github.com/letterstory/Letterprove/blob/main/src/lib/attest/aggregate.ts";
