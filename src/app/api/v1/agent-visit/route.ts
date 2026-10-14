import { collectorResponse } from "@/lib/http";

/**
 * `POST /api/v1/agent-visit` — RETIRED 2026-10-14.
 *
 * Agent visits are the Visitors product now, collected by the Letterstory app
 * (lettervisit.com/v.js and its server snippet post to the app, not here).
 * Letterprove is attestation only. Old cached copies of attest.js or a server
 * snippet installed before the split may still post here, so this answers 204
 * and records nothing, exactly as a dropped event always did.
 */
export async function POST() {
	return collectorResponse(false);
}

export async function OPTIONS() {
	return collectorResponse(false);
}
