import { describe, expect, it } from "vitest";
import { featureUsageSection, MAX_SHOWN_FEATURES, type FeatureRow } from "./feature-usage";

// Feature usage on a proof: only features the vendor chose, only company domains Letter's script saw signed in (no
// free mail, not the vendor's own; no Letterprove script needed), only a fresh report; absent when nothing would show.

const NOW = Date.parse("2026-11-11T12:00:00Z");
const VENDOR = "vendor.com";
const row = (over: Partial<FeatureRow>): FeatureRow => ({
	feature_key: "button:#export",
	label: "Export",
	people: 30,
	domains: ["acme.com", "globex.com", "gmail.com", "vendor.com"],
	published: true,
	synced_at: "2026-11-11T06:00:00Z",
	...over,
});

describe("featureUsageSection", () => {
	it("counts each feature's company domains, most first, out of every company signed in", () => {
		const s = featureUsageSection(
			[
				row({}),
				row({ feature_key: "link:/reports@nav", label: "Reports", people: 4, domains: ["initech.com", "initech.com"] }),
				row({ feature_key: "button:#hidden", label: "Hidden", published: false, domains: ["umbrella.com"] }),
			],
			VENDOR,
			30,
			NOW,
		);
		expect(s).toEqual({
			source: "letter_visitors",
			window_days: 30,
			companies_signed_in: 4,
			features: [
				{ name: "Export", companies: 2, people: 30 },
				{ name: "Reports", companies: 1, people: 4 },
			],
		});
	});

	it("leaves out what the vendor didn't choose, a stale report, and a feature no company used", () => {
		expect(featureUsageSection([row({ published: false })], VENDOR, 30, NOW)).toBeNull();
		expect(featureUsageSection([row({ synced_at: "2026-11-09T06:00:00Z" })], VENDOR, 30, NOW)).toBeNull();
		expect(featureUsageSection([row({ domains: ["gmail.com", "vendor.com"] })], VENDOR, 30, NOW)).toBeNull();
	});

	it("shows at most ten", () => {
		const rows = Array.from({ length: 15 }, (_, i) => row({ feature_key: `button:#f${i}`, label: `F${i}` }));
		expect(featureUsageSection(rows, VENDOR, 30, NOW)!.features).toHaveLength(MAX_SHOWN_FEATURES);
	});
});
