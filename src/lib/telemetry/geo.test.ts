import { describe, expect, it } from "vitest";
import { requestGeo } from "./geo";

const h = (init: Record<string, string>) => new Headers(init);

describe("requestGeo", () => {
	it("reads country and region from the edge headers", () => {
		expect(
			requestGeo(h({ "x-vercel-ip-country": "US", "x-vercel-ip-country-region": "CA" }))
		).toEqual({ country: "US", region: "CA" });
	});

	it("returns nulls when the edge could not place the request", () => {
		// Normal steady state, not an error: the edge omits these when it has no
		// answer, and local development has no edge at all.
		expect(requestGeo(h({}))).toEqual({ country: null, region: null });
	});

	it("takes country without region, and region without country", () => {
		expect(requestGeo(h({ "x-vercel-ip-country": "GB" }))).toEqual({
			country: "GB",
			region: null,
		});
		expect(requestGeo(h({ "x-vercel-ip-country-region": "ENG" }))).toEqual({
			country: null,
			region: "ENG",
		});
	});

	it("never reads city, coordinates, or postal code", () => {
		// The privacy policy names these specifically as things we do not take.
		// If someone adds one, this fails and they have to change a published
		// promise on purpose rather than by accident.
		const result = requestGeo(
			h({
				"x-vercel-ip-country": "US",
				"x-vercel-ip-country-region": "NY",
				"x-vercel-ip-city": "New%20York",
				"x-vercel-ip-latitude": "40.7128",
				"x-vercel-ip-longitude": "-74.0060",
				"x-vercel-ip-postal-code": "10001",
			})
		);

		expect(Object.keys(result).sort()).toEqual(["country", "region"]);
		const serialized = JSON.stringify(result);
		for (const leak of ["New", "40.7128", "-74.0060", "10001"]) {
			expect(serialized).not.toContain(leak);
		}
	});

	it("uppercases and trims, so one place does not become two", () => {
		expect(requestGeo(h({ "x-vercel-ip-country": " us ", "x-vercel-ip-country-region": "ca" }))).toEqual(
			{ country: "US", region: "CA" }
		);
	});

	it("drops an over-long value rather than storing it", () => {
		// Headers are attacker-controlled input even when our own edge usually
		// writes them. An unbounded string would flow into a column and then
		// out into the feature stream.
		expect(
			requestGeo(h({ "x-vercel-ip-country": "UNITED-STATES-OF-AMERICA" })).country
		).toBeNull();
	});

	it("drops values that are not plain alphanumerics", () => {
		expect(requestGeo(h({ "x-vercel-ip-country": "U;" })).country).toBeNull();
		expect(requestGeo(h({ "x-vercel-ip-country-region": "<b>" })).region).toBeNull();
	});

	it("drops an empty or whitespace-only header", () => {
		expect(requestGeo(h({ "x-vercel-ip-country": "   " })).country).toBeNull();
	});
});
