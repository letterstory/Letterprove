import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/attest/case-studies", async () => ({
	caseStudyUrl: (await vi.importActual<typeof import("@/lib/attest/case-studies")>("@/lib/attest/case-studies")).caseStudyUrl,
	publishCaseStudy: vi.fn(),
	unpublishCaseStudy: vi.fn(),
}));

import { dispatchTool } from "@/lib/tools/registry";
import { publishCaseStudy, unpublishCaseStudy } from "@/lib/attest/case-studies";

const ID = "11111111-1111-4111-8111-111111111111";
const principal = (vendorId: string | null = "v1") =>
	({
		capabilities: ["vendor:read", "vendor:write"],
		vendorId,
		orgId: "o1",
		userId: null,
	}) as unknown as OAuthPrincipal;
const payload = {
	id: ID,
	headline: "Teams use Build every day",
	paragraphs: ["4 companies signed in on most working days."],
	facts: [{ text: "4 companies signed in on most working days", numbers: [4] }],
	window: { since: "2026-10-18", until: "2026-11-16", days: 30 },
	anonymization: "counts_only",
	named_companies: [],
	source: "letter_usage_data",
};

describe("case studies (Mathew, 2026-11-14: a Letter Proof URL for the case study)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("publishes at its Letterprove URL, keyed by Letter's id", async () => {
		vi.mocked(publishCaseStudy).mockResolvedValue("ok");
		const out = await dispatchTool("publish_case_study", payload, principal());
		expect(out).toMatchObject({
			kind: "result",
			result: {
				ok: true,
				body: { url: `https://app.letterprove.com/case-studies/${ID}` },
			},
		});
		expect(publishCaseStudy).toHaveBeenCalledWith("v1", expect.objectContaining({ id: ID, headline: payload.headline }));
	});

	it("refuses another vendor's id, and an org with no vendor", async () => {
		vi.mocked(publishCaseStudy).mockResolvedValue("not_yours");
		expect(await dispatchTool("publish_case_study", payload, principal())).toMatchObject({ result: { ok: false, status: 409 } });
		expect(await dispatchTool("publish_case_study", payload, principal(null))).toMatchObject({ result: { ok: false, status: 404 } });
	});

	it("refuses a case study with no paragraphs", async () => {
		const out = await dispatchTool("publish_case_study", { ...payload, paragraphs: [] }, principal());
		expect(out).toMatchObject({ result: { ok: false, status: 400 } });
		expect(publishCaseStudy).not.toHaveBeenCalled();
	});

	it("answers unknown_tool before its table exists, so Letter serves the case study itself", async () => {
		vi.mocked(publishCaseStudy).mockResolvedValue("not_ready");
		expect(await dispatchTool("publish_case_study", payload, principal())).toMatchObject({
			result: { ok: false, status: 404, body: { error: "unknown_tool" } },
		});
	});

	it("takes one down", async () => {
		vi.mocked(unpublishCaseStudy).mockResolvedValue({ removed: true });
		expect(await dispatchTool("unpublish_case_study", { id: ID }, principal())).toMatchObject({ result: { ok: true, body: { removed: true } } });
		expect(unpublishCaseStudy).toHaveBeenCalledWith("v1", ID);
	});
});
