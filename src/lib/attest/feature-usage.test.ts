import { describe, expect, it } from "vitest";
import { featureUsageSection, MAX_SHOWN_FEATURES, type FeatureRow } from "./feature-usage";

// Feature usage on a proof: only features the vendor chose, only companies Letterprove observed signing in, only a
// fresh report; absent when nothing would show.

const NOW = Date.parse("2026-11-11T12:00:00Z");
const row = (over: Partial<FeatureRow>): FeatureRow => ({
	feature_key: "button:#export",
	label: "Export",
	people: 30,
	domains: ["acme.com", "globex.com", "stranger.io"],
	published: true,
	synced_at: "2026-11-11T06:00:00Z",
	...over,
});

describe("featureUsageSection", () => {
	const observed = new Set(["acme.com", "globex.com", "initech.com"]);

	it("counts only the companies Letterprove observed signing in, most first", () => {
		const s = featureUsageSection(
			[row({}), row({ feature_key: "link:/reports@nav", label: "Reports", people: 4, domains: ["initech.com", "initech.com"] })],
			observed,
			30,
			NOW,
		);
		expect(s).toEqual({
			source: "letter_visitors",
			window_days: 30,
			features: [
				{ name: "Export", companies: 2, people: 30 },
				{ name: "Reports", companies: 1, people: 4 },
			],
		});
	});

	it("leaves out what the vendor didn't choose, a stale report, and a feature no observed company used", () => {
		expect(featureUsageSection([row({ published: false })], observed, 30, NOW)).toBeNull();
		expect(featureUsageSection([row({ synced_at: "2026-11-09T06:00:00Z" })], observed, 30, NOW)).toBeNull();
		expect(featureUsageSection([row({ domains: ["stranger.io"] })], observed, 30, NOW)).toBeNull();
	});

	it("shows at most ten", () => {
		const rows = Array.from({ length: 15 }, (_, i) => row({ feature_key: `button:#f${i}`, label: `F${i}` }));
		expect(featureUsageSection(rows, observed, 30, NOW)!.features).toHaveLength(MAX_SHOWN_FEATURES);
	});
});
