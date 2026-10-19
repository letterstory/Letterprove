/**
 * LetterVisit (lettervisit.com) on letterprove.com: AI agents and people per page, read in
 * Letterstory's Visitors. Two halves:
 *
 *   - components/lettervisit.tsx loads the Visitors script tag (people, through its visitor
 *     pixel, and agents that drive a real browser).
 *   - proxy.ts forwards crawler requests (ChatGPT, Claude, Perplexity and the search
 *     crawlers fetch HTML without running JavaScript, so only the server sees them).
 *
 * Only on Letterprove's own site, letterprove.com and www: never on a vendor's custom proof
 * domain (proof.acme.com is the vendor's, not ours) and never on app.letterprove.com.
 *
 * The key is letterprove.com's publishable Visitors key, committed as is: Visitors counts only
 * letterprove.com, so a fork running this code on another domain counts nothing.
 */

export const LETTERVISIT_KEY = "lv_pub_oshr7i0747cjjk5tq0ch0eux";

const AGENT_VISIT_URL = "https://lettervisit.com/api/v1/agent-visit";

const SITE_HOSTS = new Set(["letterprove.com", "www.letterprove.com"]);

/** Letterprove's own marketing site. */
export function isLettervisitHost(host: string): boolean {
	return SITE_HOSTS.has(host.toLowerCase().split(":")[0]);
}

/** A page a reader opens: not the API, discovery documents, signed JSON or a static file. */
export function isLettervisitPage(pathname: string): boolean {
	if (/^\/(api|v1|_next|\.well-known|attest)(\/|$)/.test(pathname)) return false;
	return !/\.[a-z0-9]+$/i.test(pathname);
}

const AGENT_UA =
	/bot|crawl|spider|agent|fetch|chatgpt|claude|perplexity|anthropic|openai|gemini|google|mistral|cohere|externalhit|-user\b/i;

/** Crawlers and assistants; people's browsers are counted by the script instead. */
export function isAgentRequest(userAgent: string | null, signatureAgent: string | null): boolean {
	return AGENT_UA.test(userAgent ?? "") || !!signatureAgent;
}

/** Forward one crawler request. Fire-and-forget; resolves either way. */
export async function forwardAgentVisit(input: {
	userAgent: string | null;
	ip: string | null;
	path: string;
	host: string;
	signatureAgent: string | null;
}): Promise<void> {
	try {
		await fetch(AGENT_VISIT_URL, {
			method: "POST",
			body: JSON.stringify({
				k: LETTERVISIT_KEY,
				ua: input.userAgent ?? "",
				ip: input.ip,
				path: input.path,
				host: input.host,
				signature_agent: input.signatureAgent,
			}),
			cache: "no-store",
		});
	} catch {
		// Swallowed by design: a lost report is cheaper than a page error.
	}
}
