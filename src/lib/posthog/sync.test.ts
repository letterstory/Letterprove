import { describe, expect, it, vi } from "vitest";
import { mergeRows } from "./sync";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

describe("mergeRows", () => {
	it("joins history and activity on domain", () => {
		const merged = mergeRows(
			[
				{ domain: "acme.com", firstSeen: "2024-01-01T00:00:00.000Z", people: 5 },
				{ domain: "old.io", firstSeen: "2023-05-01T00:00:00.000Z", people: 1 },
			],
			[
				{ domain: "acme.com", people: 2, sessions: 9, lastSeen: "2026-10-12T00:00:00.000Z" },
				{ domain: "new.dev", people: 3, sessions: 4, lastSeen: "2026-10-11T00:00:00.000Z" },
			],
		);
		const by = Object.fromEntries(merged.map((m) => [m.domain, m]));
		expect(by["acme.com"]).toMatchObject({ people: 5, activePeople30d: 2, sessions30d: 9, firstSeen: "2024-01-01T00:00:00.000Z" });
		expect(by["old.io"]).toMatchObject({ activePeople30d: 0, lastSeen: null });
		// Active this month but past the persons read's cap: still counted as people.
		expect(by["new.dev"]).toMatchObject({ people: 3, firstSeen: null });
	});
});
