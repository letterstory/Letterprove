// The gap this test closes: unit tests of browserLogin / refreshAccessToken /
// revokeToken each with a hand-built fetchImpl prove each function's request
// shape, but never the PIPE between them — that the tokens a real login issues
// are the ones a subsequent call actually presents, that an access token the
// server rejects really drives LetterproveClient's own 401 -> tryRefresh ->
// retry path (cli/lib/client.mjs), and that the rotated pair really gets handed
// back for persistence.
//
// That blind spot has already shipped an incident in the sister product this
// implementation is ported from: the manual smoke test exercised the
// authorization_code grant and never the refresh_token grant — the only path
// that touched the then-unset OAuth encryption key.
//
// So the real client modules run unmocked against a real local HTTP server
// implementing the three-endpoint contract (/api/oauth/token with grant-type
// branching and rotation, /api/oauth/revoke, and a Bearer-protected
// /api/v1/whoami). The only thing mocked is node:child_process#spawn, so
// browserLogin never actually opens a browser.
//
// What this does NOT cover, and cannot without a database: the server halves in
// src/lib/oauth/core.ts and the /authorize + consent legs. This test's server is
// a stand-in for that contract, not a test of it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));

import { CLIENT_ID, browserLogin, refreshAccessToken, revokeToken } from "../../../cli/lib/oauth.mjs";
import { LetterproveClient } from "../../../cli/lib/client.mjs";

type Tokens = { access_token: string; refresh_token: string; expires_in: number; scope: string };

function fakeChildProcess() {
	return { on: vi.fn(), unref: vi.fn() };
}

// browserLogin hands the authorize URL to spawn(); intercepting it there is how
// the test learns the ephemeral loopback port the CLI just bound.
function captureAuthorizeUrl(): Promise<URL> {
	return new Promise((resolve) => {
		spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
			const raw = args.find((a) => typeof a === "string" && a.startsWith("http"));
			resolve(new URL(raw!));
			return fakeChildProcess();
		});
	});
}

// Stands in for the browser's redirect back to the loopback listener.
async function completeCallback(authorizeUrl: URL, params: Record<string, string>) {
	const callback = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
	for (const [k, v] of Object.entries(params)) callback.searchParams.set(k, v);
	await fetch(callback.toString());
}

// browserLogin rejects while the test is still awaiting the loopback callback,
// which is before an `expect(...).rejects` assertion could attach its handler —
// vitest reports that window as an unhandled rejection and fails the run. So the
// handler is attached at creation and the error is asserted on afterwards.
function settle(promise: Promise<unknown>): Promise<Error | null> {
	return promise.then(
		() => null,
		(err: Error) => err,
	);
}

function makeIo() {
	const logs: string[] = [];
	return { log: (m: string) => logs.push(m), error: (m: string) => logs.push(m), out: () => logs.join("\n") };
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
	let raw = "";
	for await (const chunk of req) raw += chunk;
	return new URLSearchParams(raw);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

const VENDOR = { id: "11111111-1111-1111-1111-111111111111", slug: "acme", name: "Acme Inc", domain: "acme.test" };
const SCOPE = "offline_access vendor:read vendor:write";

/**
 * A minimal but real implementation of the token/revoke/whoami contract: one
 * authorization_code exchange, one refresh_token rotation, and a /api/v1/whoami
 * that only accepts whichever access token is CURRENTLY valid — which forces a
 * genuine 401 while the CLI still holds the pre-rotation token, exactly as an
 * aged-out token would in production.
 */
function makeOAuthServer() {
	const revoked = new Set<string>();
	const seenAuthorizeParams: Record<string, string> = {};
	let currentAccessToken: string | null = null;
	let currentRefreshToken: string | null = null;

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");

		if (req.method === "POST" && url.pathname === "/api/oauth/token") {
			void readForm(req).then((form) => {
				for (const [k, v] of form.entries()) seenAuthorizeParams[k] = v;
				if (form.get("client_id") !== CLIENT_ID) {
					sendJson(res, 400, { error: "invalid_client" });
					return;
				}
				const grantType = form.get("grant_type");

				if (grantType === "authorization_code") {
					if (form.get("code") !== "test-auth-code") {
						sendJson(res, 400, { error: "invalid_grant", error_description: "unknown code" });
						return;
					}
					// PKCE: a code exchange without a verifier must never succeed.
					if (!form.get("code_verifier")) {
						sendJson(res, 400, { error: "invalid_request", error_description: "missing code_verifier" });
						return;
					}
					currentAccessToken = "lp_oat_1";
					currentRefreshToken = "lp_ort_1";
					sendJson(res, 200, {
						access_token: currentAccessToken,
						refresh_token: currentRefreshToken,
						expires_in: 3600,
						scope: SCOPE,
					});
					return;
				}

				if (grantType === "refresh_token") {
					const presented = form.get("refresh_token");
					if (presented !== currentRefreshToken || revoked.has(presented ?? "")) {
						sendJson(res, 400, {
							error: "invalid_grant",
							error_description: "refresh token reused or unknown",
						});
						return;
					}
					// Rotate — the old pair is retired the instant the new one is minted.
					currentAccessToken = "lp_oat_2";
					currentRefreshToken = "lp_ort_2";
					sendJson(res, 200, {
						access_token: currentAccessToken,
						refresh_token: currentRefreshToken,
						expires_in: 3600,
						scope: SCOPE,
					});
					return;
				}

				sendJson(res, 400, { error: "unsupported_grant_type" });
			});
			return;
		}

		if (req.method === "POST" && url.pathname === "/api/oauth/revoke") {
			void readForm(req).then((form) => {
				const token = form.get("token");
				if (token) revoked.add(token);
				// RFC 7009: always 200, never an oracle for token validity.
				sendJson(res, 200, {});
			});
			return;
		}

		if (req.method === "GET" && url.pathname === "/api/v1/whoami") {
			const auth = req.headers.authorization ?? "";
			const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
			// The token minted straight off the code exchange is treated as
			// already-expired, forcing every caller through a real refresh round
			// trip before this can succeed.
			if (!presented || presented === "lp_oat_1" || presented !== currentAccessToken || revoked.has(presented)) {
				res.writeHead(401, {
					"content-type": "application/json",
					"www-authenticate": 'Bearer error="invalid_token"',
				});
				res.end(JSON.stringify({ error: "invalid_token" }));
				return;
			}
			sendJson(res, 200, { vendor: VENDOR, capabilities: ["vendor:read", "vendor:write"] });
			return;
		}

		res.writeHead(404).end();
	});

	return { server, isRevoked: (token: string) => revoked.has(token), lastForm: seenAuthorizeParams };
}

let server: http.Server;
let isRevoked: (token: string) => boolean;
let lastForm: Record<string, string>;
let baseUrl: string;

beforeEach(async () => {
	spawnMock.mockReset();
	const made = makeOAuthServer();
	server = made.server;
	isRevoked = made.isRevoked;
	lastForm = made.lastForm;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const addr = server.address();
	baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("CLI OAuth lifecycle — login -> silent refresh -> logout, against a real server", () => {
	it("logs in, transparently refreshes a rejected access token on first use, then revokes both tokens on logout", async () => {
		// 1. login (authorization_code grant) through the real loopback + PKCE flow.
		const urlCaptured = captureAuthorizeUrl();
		const io = makeIo();
		const loginPromise = browserLogin({ url: baseUrl, io }) as Promise<Tokens>;
		const authorizeUrl = await urlCaptured;

		expect(authorizeUrl.searchParams.get("client_id")).toBe("letterprove_cli");
		expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
		// RFC 8252 §7.3: loopback only, on an OS-assigned ephemeral port.
		const redirectUri = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
		expect(redirectUri.hostname).toBe("127.0.0.1");
		expect(Number(redirectUri.port)).toBeGreaterThan(0);

		await completeCallback(authorizeUrl, {
			code: "test-auth-code",
			state: authorizeUrl.searchParams.get("state")!,
		});
		const initialTokens = await loginPromise;
		expect(initialTokens.access_token).toBe("lp_oat_1");
		expect(initialTokens.refresh_token).toBe("lp_ort_1");
		// The verifier really travelled with the exchange, not just the challenge
		// with the authorize request.
		expect(lastForm.code_verifier).toBeTruthy();

		let persisted = {
			access_token: initialTokens.access_token,
			refresh_token: initialTokens.refresh_token,
			expires_at: Date.now() + initialTokens.expires_in * 1000,
			scope: initialTokens.scope,
		};

		// 2. A real authenticated call. The server only accepts the post-rotation
		// access token, so this MUST exercise the client's own 401 -> tryRefresh()
		// -> refresh_token grant -> retry path, not a simulated one.
		const client = new LetterproveClient({
			url: baseUrl,
			oauth: persisted,
			onTokensRefreshed: (t: typeof persisted) => {
				persisted = t;
			},
		});
		const me = await client.whoami();
		expect(me.vendor).toEqual(VENDOR);
		expect(me.capabilities).toEqual(["vendor:read", "vendor:write"]);

		// The silent refresh really rotated and really handed back the new pair.
		expect(persisted.access_token).toBe("lp_oat_2");
		expect(persisted.refresh_token).toBe("lp_ort_2");
		expect(persisted.access_token).not.toBe(initialTokens.access_token);

		// 3. logout: revoke both current tokens, exactly as cmdLogout does.
		await revokeToken({ url: baseUrl, token: persisted.access_token });
		await revokeToken({ url: baseUrl, token: persisted.refresh_token });
		expect(isRevoked(persisted.access_token)).toBe(true);
		expect(isRevoked(persisted.refresh_token)).toBe(true);

		// And the revoked refresh token is really dead — no silent refresh is
		// possible after logout.
		await expect(refreshAccessToken({ url: baseUrl, refreshToken: persisted.refresh_token })).rejects.toThrow(
			/reused or unknown/,
		);

		expect(io.out()).toContain("Opening your browser");
	});

	it("refuses a callback whose state does not match the one it sent", async () => {
		// The loopback listener is a plain local HTTP server; anything on the
		// machine can hit it. State is the only thing that stops a code from a
		// login this process did not start.
		const urlCaptured = captureAuthorizeUrl();
		const settled = settle(browserLogin({ url: baseUrl, io: makeIo() }));
		const authorizeUrl = await urlCaptured;

		await completeCallback(authorizeUrl, { code: "test-auth-code", state: "not-the-state-we-sent" });

		expect((await settled)?.message).toMatch(/state mismatch/);
	});

	it("surfaces a denied authorization instead of hanging", async () => {
		const urlCaptured = captureAuthorizeUrl();
		const settled = settle(browserLogin({ url: baseUrl, io: makeIo() }));
		const authorizeUrl = await urlCaptured;

		await completeCallback(authorizeUrl, {
			error: "access_denied",
			error_description: "The user denied the request",
			state: authorizeUrl.searchParams.get("state")!,
		});

		expect((await settled)?.message).toMatch(/denied the request/);
	});

	it("tells an unauthenticated caller to log in rather than sending a header-less request", async () => {
		const client = new LetterproveClient({ url: baseUrl, oauth: null });
		await expect(client.whoami()).rejects.toThrow(/Not logged in/);
	});

	it("gives up with a re-login message when there is no refresh token to fall back on", async () => {
		const client = new LetterproveClient({
			url: baseUrl,
			// lp_oat_1 is the token this server always rejects, and there is no
			// refresh token, so there is no recovery path.
			oauth: { access_token: "lp_oat_1" },
		});
		await expect(client.whoami()).rejects.toThrow(/session has expired/);
	});
});
