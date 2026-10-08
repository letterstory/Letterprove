import { describe, expect, it } from "vitest";
import { FREEZE_MINUTE, nextSnapshotAt, SNAPSHOT_CADENCE_SECONDS } from "./cadence";
import vercel from "../../../vercel.json";

describe("nextSnapshotAt", () => {
	it("is the next :05 freeze after a snapshot cut at the freeze", () => {
		expect(nextSnapshotAt("2026-10-08T03:05:08.160Z")).toBe("2026-10-08T04:05:00.000Z");
	});

	it("is later the same hour for a snapshot cut before :05", () => {
		expect(nextSnapshotAt("2026-10-08T03:02:00.000Z")).toBe("2026-10-08T03:05:00.000Z");
	});

	it("is always strictly after the snapshot, even one cut exactly at :05", () => {
		expect(nextSnapshotAt("2026-10-08T03:05:00.000Z")).toBe("2026-10-08T04:05:00.000Z");
	});

	it("rolls over midnight", () => {
		expect(nextSnapshotAt("2026-10-08T23:40:00.000Z")).toBe("2026-10-09T00:05:00.000Z");
	});

	it("matches the freeze cron it promises — a drifted schedule would make every next_snapshot_at a lie", () => {
		const freeze = vercel.crons.find((c) => c.path === "/api/cron/freeze");
		expect(freeze?.schedule).toBe(`${FREEZE_MINUTE} * * * *`);
		expect(SNAPSHOT_CADENCE_SECONDS).toBe(3600);
	});
});
