/**
 * Is this request really from the AI agent its user-agent claims?
 *
 * A user-agent is a free-text header anyone can set, so a claim alone cannot
 * be billed: a loop sending "GPTBot" at a vendor's proof would run up that
 * vendor's bill. The operators that matter publish the address ranges their
 * agents fetch from, as JSON in one shared shape —
 * `{ prefixes: [{ ipv4Prefix } | { ipv6Prefix }] }` — so a claim is checked
 * against the claimed operator's own list.
 *
 * Keyed by the canonical name `classify()` returns. An agent with no entry
 * here publishes nothing to check against (Meta, Mistral, Cohere, ByteDance,
 * Diffbot, You.com at the time of writing): its reads are recorded but never
 * verified, so never billed. Google-Extended is a robots.txt token, not a
 * user-agent — Gemini fetches as Google's own crawlers and fetchers, hence
 * Google's lists under "gemini".
 *
 * Fails closed: an unreachable or malformed list verifies nothing. Unverified
 * means "not billed", so the failure mode of this module is undercharging,
 * never overcharging.
 */

export const RANGE_SOURCES: Record<string, string[]> = {
	chatgpt: [
		"https://openai.com/gptbot.json",
		"https://openai.com/searchbot.json",
		"https://openai.com/chatgpt-user.json",
	],
	claude: ["https://claude.com/crawling/bots.json"],
	perplexity: ["https://www.perplexity.ai/perplexitybot.json", "https://www.perplexity.ai/perplexity-user.json"],
	gemini: [
		"https://developers.google.com/static/crawling/ipranges/common-crawlers.json",
		"https://developers.google.com/static/crawling/ipranges/special-crawlers.json",
		"https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json",
	],
	apple: ["https://search.developer.apple.com/applebot.json"],
	commoncrawl: ["https://index.commoncrawl.org/ccbot.json"],
};

/** Lists change rarely; a day-old copy is fine, and refetching per read would be absurd. */
const TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

interface Cidr {
	v6: boolean;
	base: bigint;
	mask: bigint;
}

const cache = new Map<string, { at: number; cidrs: Cidr[] }>();

/** Test seam: forget every cached list. */
export function _resetRangeCache(): void {
	cache.clear();
}

/** The client address as Vercel reports it. Vercel sets these itself; a client cannot forge them. */
export function clientIp(headers: Headers): string | null {
	const raw =
		headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip") ?? headers.get("x-forwarded-for");
	const first = raw?.split(",")[0]?.trim();
	return first || null;
}

export async function isVerifiedAgent(agentName: string, ip: string | null): Promise<boolean> {
	const sources = RANGE_SOURCES[agentName];
	if (!sources || !ip) return false;
	const addr = parseIp(ip);
	if (!addr) return false;
	for (const url of sources) {
		const cidrs = await rangesFrom(url);
		if (cidrs.some((c) => c.v6 === addr.v6 && (addr.value & c.mask) === c.base)) return true;
	}
	return false;
}

async function rangesFrom(url: string): Promise<Cidr[]> {
	const hit = cache.get(url);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.cidrs;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = (await res.json()) as { prefixes?: { ipv4Prefix?: string; ipv6Prefix?: string }[] };
		const cidrs = (body.prefixes ?? [])
			.map((p) => parseCidr(p.ipv4Prefix ?? p.ipv6Prefix ?? ""))
			.filter((c): c is Cidr => c !== null);
		if (cidrs.length === 0) throw new Error("no prefixes");
		cache.set(url, { at: Date.now(), cidrs });
		return cidrs;
	} catch (error) {
		console.error("[letterprove:access] agent range list unavailable", url, error instanceof Error ? error.message : String(error));
		// A stale list beats none: ranges move slowly, and failing closed on
		// a transient fetch error would stop billing honest reads for no reason.
		return hit?.cidrs ?? [];
	}
}

function parseCidr(cidr: string): Cidr | null {
	const [ip, bitsRaw] = cidr.split("/");
	const addr = parseIp(ip ?? "");
	if (!addr) return null;
	const width = addr.v6 ? 128 : 32;
	const bits = bitsRaw === undefined ? width : Number(bitsRaw);
	if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
	const all = (1n << BigInt(width)) - 1n;
	const mask = bits === 0 ? 0n : (all << BigInt(width - bits)) & all;
	return { v6: addr.v6, base: addr.value & mask, mask };
}

/** IPv4 or IPv6 as an integer. IPv4-mapped IPv6 (::ffff:1.2.3.4) is read as the IPv4 it carries. */
export function parseIp(raw: string): { v6: boolean; value: bigint } | null {
	const ip = raw.trim();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped) return parseIp(mapped[1]);
	if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
		const parts = ip.split(".").map(Number);
		if (parts.some((p) => p > 255)) return null;
		return { v6: false, value: parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n) };
	}
	if (!ip.includes(":") || !/^[0-9a-f:]+$/i.test(ip)) return null;
	const halves = ip.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
	if (groups.length !== 8 || groups.some((g) => g.length === 0 || g.length > 4)) return null;
	return { v6: true, value: groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n) };
}
