// Browser-based OAuth 2.1 login (RFC 8252 loopback redirect + PKCE) for the
// Letterprove CLI.
//
// Letterprove holds no identity of its own since the 2026-09 auth
// unification (see src/lib/oauth-auth.ts) — its own /api/oauth/* server was
// retired along with local vendor accounts. This CLI now authenticates
// against LETTERSTORY's authorization server instead (`url` below is
// Letterstory's origin, see DEFAULT_API_URL in ./client.mjs), using the same
// `letterstory_cli` client Letterstory's own CLI logs in as — it already
// carries wildcard scope, so a login here grants the `vendor:read`/
// `vendor:write` capabilities Letterprove's tools require. This is the exact
// mechanism, unmodified; only which server it talks to changed.
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { CliError } from "./client.mjs";

export const CLIENT_ID = "letterstory_cli";
const CALLBACK_TIMEOUT_MS = 180_000;

function generatePkce() {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function openBrowser(url) {
	let cmd, args;
	if (process.platform === "darwin") {
		cmd = "open";
		args = [url];
	} else if (process.platform === "win32") {
		cmd = "cmd";
		args = ["/c", "start", '""', url];
	} else {
		cmd = "xdg-open";
		args = [url];
	}
	try {
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		// A headless box has no browser to open; the URL was already printed, so
		// failing here is not fatal.
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

const CALLBACK_HTML_OK = `<!doctype html><html><head><meta charset="utf-8"><title>Letterprove CLI</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; text-align: center;">
<h2>You're signed in.</h2><p>You can close this tab and return to your terminal.</p>
</body></html>`;

const CALLBACK_HTML_ERROR = `<!doctype html><html><head><meta charset="utf-8"><title>Letterprove CLI</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; text-align: center;">
<h2>Sign-in failed.</h2><p>Return to your terminal for details.</p>
</body></html>`;

// RFC 8252 §7.3: bind loopback only, let the OS pick an ephemeral port, and use
// whatever port it gave us in the (registered-but-portless) redirect_uri.
function startLoopbackServer() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		let settled = false;

		const resultPromise = new Promise((resolveResult) => {
			server.on("request", (req, res) => {
				const url = new URL(req.url, "http://127.0.0.1");
				if (url.pathname !== "/callback") {
					res.writeHead(404).end();
					return;
				}
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");
				const errorDescription = url.searchParams.get("error_description");
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(error ? CALLBACK_HTML_ERROR : CALLBACK_HTML_OK);
				if (!settled) {
					settled = true;
					resolveResult(error ? { error, errorDescription } : { code, state });
				}
			});
			server.on("error", (err) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
		});

		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				port,
				redirectUri: `http://127.0.0.1:${port}/callback`,
				waitForCallback: () => resultPromise,
				close: () => new Promise((r) => server.close(r)),
			});
		});
	});
}

async function withTimeout(promise, ms, message) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new CliError(message)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function tokenRequest(url, body, fetchImpl) {
	const endpoint = `${url.replace(/\/+$/, "")}/api/oauth/token`;
	let res;
	try {
		res = await fetchImpl(endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(body).toString(),
		});
	} catch (err) {
		throw new CliError(`Could not reach ${endpoint}: ${err.message}`);
	}
	const json = await res.json().catch(() => null);
	if (!res.ok || !json?.access_token) {
		const detail = json?.error_description || json?.error || `HTTP ${res.status}`;
		throw new CliError(`Login failed: ${detail}`);
	}
	return json;
}

/**
 * Opens the system browser, runs a one-shot loopback listener, and exchanges
 * the resulting code for a token pair. No `scope` is sent, so the server grants
 * the CLI client's full current scope — including offline_access, so a plain
 * `letterprove login` always comes back with a refresh token. Asking for a
 * frozen list here would reintroduce, on the client side, exactly the staleness
 * the server's '*' wildcard exists to avoid.
 */
export async function browserLogin({ url, io, fetchImpl = globalThis.fetch }) {
	const { verifier, challenge } = generatePkce();
	const state = randomBytes(16).toString("hex");
	const server = await startLoopbackServer();

	const authUrl = new URL(`${url.replace(/\/+$/, "")}/api/oauth/authorize`);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("client_id", CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", server.redirectUri);
	authUrl.searchParams.set("state", state);
	authUrl.searchParams.set("code_challenge", challenge);
	authUrl.searchParams.set("code_challenge_method", "S256");

	io.log("Opening your browser to sign in…");
	io.log(`If it doesn't open automatically, visit:\n  ${authUrl.toString()}\n`);
	openBrowser(authUrl.toString());

	try {
		const result = await withTimeout(
			server.waitForCallback(),
			CALLBACK_TIMEOUT_MS,
			"Timed out waiting for the browser sign-in. Please try again.",
		);
		if (result.error) {
			throw new CliError(`Sign-in was not completed: ${result.errorDescription || result.error}`);
		}
		// The state check is what stops a third party from feeding this listener
		// a code from a login it started — the listener is a plain local HTTP
		// server that anything on the machine could hit.
		if (result.state !== state) {
			throw new CliError("Sign-in response failed a security check (state mismatch). Please try again.");
		}
		if (!result.code) {
			throw new CliError("Sign-in did not return an authorization code. Please try again.");
		}

		return await tokenRequest(
			url,
			{
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code: result.code,
				redirect_uri: server.redirectUri,
				code_verifier: verifier,
			},
			fetchImpl,
		);
	} finally {
		await server.close();
	}
}

export async function refreshAccessToken({ url, refreshToken, fetchImpl = globalThis.fetch }) {
	return tokenRequest(
		url,
		{ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken },
		fetchImpl,
	);
}

// Best-effort: RFC 7009 revocation always "succeeds" server-side, and a network
// failure here must not block a local logout — leaving credentials on disk
// because the network was down is the worse outcome.
export async function revokeToken({ url, token, fetchImpl = globalThis.fetch }) {
	const endpoint = `${url.replace(/\/+$/, "")}/api/oauth/revoke`;
	try {
		await fetchImpl(endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token, client_id: CLIENT_ID }).toString(),
		});
	} catch {
		// ignore — logout still clears local state
	}
}
