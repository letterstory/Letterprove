import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn(() => ({})) }));
vi.mock("@/lib/alerts/notify", () => ({ sendAlert: vi.fn() }));
vi.mock("@/lib/vendors/dns-recheck", () => ({ recheckAllDomains: vi.fn() }));
vi.mock("@/lib/vendors/hosts", () => ({
	recheckOwnDnsHosts: vi.fn(async () => ({ checked: 0, unverified: [], errors: [] })),
}));

import { GET } from "./route";
import { sendAlert } from "@/lib/alerts/notify";
import { recheckAllDomains } from "@/lib/vendors/dns-recheck";
import { recheckOwnDnsHosts } from "@/lib/vendors/hosts";

const req = (auth?: string) =>
	new Request("https://app.letterprove.com/api/cron/dns-recheck", auth ? { headers: { authorization: auth } } : {});

describe("GET /api/cron/dns-recheck", () => {
	beforeEach(() => {
		vi.stubEnv("CRON_SECRET", "s3cret");
		vi.mocked(sendAlert).mockReset();
	});
	afterEach(() => vi.unstubAllEnvs());

	it("refuses a caller without the cron secret, and fails closed when it is unset", async () => {
		expect((await GET(req())).status).toBe(401);
		expect((await GET(req("Bearer wrong"))).status).toBe(401);
		vi.stubEnv("CRON_SECRET", "");
		expect((await GET(req("Bearer "))).status).toBe(401);
		expect(recheckAllDomains).not.toHaveBeenCalled();
	});

	it("alerts once per vendor whose verification the run cleared", async () => {
		vi.mocked(recheckAllDomains).mockResolvedValue({
			ok: true,
			checked: 2,
			present: 1,
			missed: 1,
			unreachable: 0,
			unverified: ["gone"],
			errors: [],
		});
		const res = await GET(req("Bearer s3cret"));
		expect(res.status).toBe(200);
		expect(sendAlert).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sendAlert).mock.calls[0][0]).toBe("domain verification cleared: gone");
	});

	it("re-checks own-DNS hosts and alerts when one is cleared", async () => {
		vi.mocked(recheckAllDomains).mockResolvedValue({
			ok: true,
			checked: 1,
			present: 1,
			missed: 0,
			unreachable: 0,
			unverified: [],
			errors: [],
		});
		vi.mocked(recheckOwnDnsHosts).mockResolvedValueOnce({ checked: 1, unverified: ["acme:eu.acme.com"], errors: [] });
		const res = await GET(req("Bearer s3cret"));
		expect(res.status).toBe(200);
		expect((await res.json()).hosts.unverified).toEqual(["acme:eu.acme.com"]);
		expect(vi.mocked(sendAlert).mock.calls[0][0]).toBe("host verification cleared: acme:eu.acme.com");
	});
});
