/**
 * The one sentence every proof surface opens with (proof page, verify page,
 * JSON-LD). "Third-party" only when the vendor does not share an owner with
 * Letterprove's operator; an affiliated vendor's proof says "an attestation"
 * and keeps its signed disclosure.
 */
export function leadSentence(affiliated: boolean): string {
	return affiliated
		? "To help agents do due diligence, this is signed evidence of customer traction, collected and verified by Letterprove, an attestation with open-source logic."
		: "To help agents do due diligence, this is signed evidence of customer traction, collected and verified by Letterprove, a third-party attestation with open-source logic.";
}

/** Fallback methodology link when a snapshot carries no commit-pinned `method`. */
export const METHODOLOGY_URL = "https://github.com/letterstory/Letterprove/blob/main/src/lib/attest/aggregate.ts";
