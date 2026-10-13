import { describe, expect, it } from "vitest";
import { attributeVisitors, rollupCompanies, statusOf } from "./visitors";
import { profileIdFromSnippet, type MaverickPerson } from "@/lib/maverick/client";

/**
 * attributeVisitors is the whole tenant boundary: our Maverick account holds
 * every tracked site, so a pull sees everyone's people, and this function
 * decides which of them one vendor may see.
 */

const REF = "letterprove:v1";
const SINCE = "2026-10-01T00:00:00.000Z";

function person(over: Partial<MaverickPerson>): MaverickPerson {
	return {
		id: "p1",
		email: "x@personal.example",
		businessEmail: "ada@acme.example",
		firstName: "Ada",
		lastName: "L",
		title: "CTO",
		company: "Acme",
		location: null,
		linkedinUrl: null,
		visitCount: 3,
		firstSeen: "2026-10-02T00:00:00.000Z",
		lastSeen: "2026-10-10T00:00:00.000Z",
		classifiedSeniority: null,
		classifiedJobFunction: null,
		companyData: { name: "Acme", domain: "acme.example" },
		domain: "vendor.example",
		clientRef: null,
		...over,
	};
}

describe("attributeVisitors", () => {
	const hosts = new Set(["vendor.example", "app.vendor.example"]);

	it("keeps people seen on the vendor's hosts or stamped with its clientRef, and drops everyone else", () => {
		const rows = attributeVisitors(
			[
				person({ id: "a" }),
				person({ id: "b", domain: "APP.vendor.example" }),
				person({ id: "c", domain: "someone-else.example" }),
				person({ id: "d", domain: "elsewhere.example", clientRef: REF }),
				person({ id: "e", domain: null, clientRef: "letterprove:other" }),
			],
			hosts,
			REF,
			SINCE,
		);
		expect(rows.map((r) => r.person_id).sort()).toEqual(["a", "b", "d"]);
	});

	it("drops people last seen before the window and dedupes by person", () => {
		const rows = attributeVisitors(
			[person({ id: "a" }), person({ id: "a" }), person({ id: "old", lastSeen: "2026-09-01T00:00:00.000Z" })],
			hosts,
			REF,
			SINCE,
		);
		expect(rows.map((r) => r.person_id)).toEqual(["a"]);
	});

	it("hands over a work address only, never a personal one", () => {
		const [withWork] = attributeVisitors([person({})], hosts, REF, SINCE);
		expect(withWork.email).toBe("ada@acme.example");
		const [personalOnly] = attributeVisitors([person({ businessEmail: null })], hosts, REF, SINCE);
		expect(personalOnly.email).toBeNull();
	});
});

describe("rollupCompanies", () => {
	it("groups by company domain, busiest first", () => {
		const people = attributeVisitors(
			[
				person({ id: "a", visitCount: 2 }),
				person({ id: "b", visitCount: 5, lastSeen: "2026-10-12T00:00:00.000Z" }),
				person({ id: "c", company: "Globex", companyData: { name: "Globex", domain: "globex.example" } }),
			],
			new Set(["vendor.example"]),
			REF,
			SINCE,
		);
		expect(rollupCompanies(people)).toEqual([
			{ company: "Acme", domain: "acme.example", people: 2, visits: 7, last_seen: "2026-10-12T00:00:00.000Z" },
			{ company: "Globex", domain: "globex.example", people: 1, visits: 3, last_seen: "2026-10-10T00:00:00.000Z" },
		]);
	});
});

describe("statusOf", () => {
	it("is active only with both pixel ids", () => {
		const base = { visitor_identification_enabled: true, maverick_domains: [] };
		expect(statusOf({ ...base, maverick_customer_id: "1091", maverick_profile_id: "abc" }).tracking).toBe("active");
		expect(statusOf({ ...base, maverick_customer_id: "1091", maverick_profile_id: null }).tracking).toBe("pending_registration");
		expect(statusOf({ ...base, visitor_identification_enabled: false, maverick_customer_id: "1091", maverick_profile_id: "abc" }).tracking).toBe("off");
	});
});

describe("profileIdFromSnippet", () => {
	it("reads either form of Maverick's install snippet", () => {
		expect(profileIdFromSnippet('<script src="x" data-customer-id="1091" data-profile-id="roxaObLRwvD"></script>')).toBe("roxaObLRwvD");
		expect(profileIdFromSnippet('{customerId:"1091",profileId:"roxaObLRwvD",cdn:"c"}')).toBe("roxaObLRwvD");
		expect(profileIdFromSnippet("<script></script>")).toBeNull();
		expect(profileIdFromSnippet(undefined)).toBeNull();
	});
});
