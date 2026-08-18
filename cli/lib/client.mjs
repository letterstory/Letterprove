// Config resolution and the authenticated transport for the Letterprove CLI.
//
// There is no static-API-key path here, deliberately: the server has exactly
// one non-browser credential (an OAuth access token, see src/lib/oauth-auth.ts),
// so the CLI has exactly one too. A second credential kind that the server
// cannot actually verify would be a worse failure than not having one.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const DEFAULT_API_URL = "https://app.letterprove.com";

// A CliError is a message already made human-readable; the entry point prints
// it and exits 1 without a stack trace. Anything else is a real bug.
export class CliError extends Error {}

// Config lives at ~/.letterprove/config.json. LETTERPROVE_CONFIG_HOME overrides
// the home directory — the tests point it at a temp dir so they never touch a
// real developer's session.
export function configPath() {
	const home = process.env.LETTERPROVE_CONFIG_HOME || homedir();
	return join(home, ".letterprove", "config.json");
}

export function readConfigFile() {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// A corrupt config should send you to `login`, not crash every command.
		return {};
	}
}

// The file holds live credentials, so it is written owner-only (0600) and the
// mode is re-asserted in case it already existed with looser bits.
export function writeConfigFile(config) {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

export function clearConfigFile() {
	const path = configPath();
	if (existsSync(path)) rmSync(path);
	return path;
}

// Precedence: explicit flag > env > config file > built-in default.
export function resolveConfig({ url } = {}) {
	const file = readConfigFile();
	return {
		url: url || process.env.LETTERPROVE_API_URL || file.url || DEFAULT_API_URL,
		oauth: file.oauth?.access_token ? file.oauth : null,
	};
}

export class LetterproveClient {
	// `oauth` is { access_token, refresh_token, expires_at, scope } from a
	// browser login. `onTokensRefreshed(oauth)` fires after a successful silent
	// refresh so the caller can persist the new pair — this class never touches
	// the config file itself, which keeps it usable from a test with no home dir.
	constructor({ url, oauth, fetchImpl, onTokensRefreshed, bin } = {}) {
		this.url = (url || DEFAULT_API_URL).replace(/\/+$/, "");
		this.oauth = oauth || null;
		this.fetch = fetchImpl || globalThis.fetch;
		this.onTokensRefreshed = onTokensRefreshed || (() => {});
		this.bin = bin || "letterprove";
	}

	authHeaders() {
		return this.oauth?.access_token ? { authorization: `Bearer ${this.oauth.access_token}` } : null;
	}

	/**
	 * One authenticated round trip. A single 401/403 triggers one silent
	 * refresh-and-retry before giving up — an access token lives an hour, so
	 * most calls from a long-lived terminal session hit exactly this path, and
	 * making the user re-login for it would defeat having refresh tokens at all.
	 */
	async request(path, { method = "GET", body, _retried = false } = {}) {
		const headers = this.authHeaders();
		if (!headers) throw new CliError(`Not logged in. Run \`${this.bin} login\`.`);

		const endpoint = `${this.url}${path}`;
		let res;
		try {
			res = await this.fetch(endpoint, {
				method,
				headers: {
					accept: "application/json",
					...(body ? { "content-type": "application/json" } : {}),
					...headers,
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
		} catch (err) {
			throw new CliError(`Could not reach ${endpoint}: ${err.message}`);
		}

		if (res.status === 401 || res.status === 403) {
			if (!_retried && this.oauth?.refresh_token && (await this.tryRefresh())) {
				return this.request(path, { method, body, _retried: true });
			}
			throw new CliError(
				`Authentication failed (HTTP ${res.status}). Your session has expired — run \`${this.bin} login\` again.`,
			);
		}

		const json = await res.json().catch(() => null);
		if (!res.ok) {
			const detail = json?.error_description || json?.error || `HTTP ${res.status}`;
			throw new CliError(`Request failed: ${detail}`);
		}
		return json ?? {};
	}

	// Best-effort silent refresh. Returns false (never throws) so request() can
	// fall through to its normal "please log in again" error on any failure.
	async tryRefresh() {
		try {
			const { refreshAccessToken } = await import("./oauth.mjs");
			const tokens = await refreshAccessToken({
				url: this.url,
				refreshToken: this.oauth.refresh_token,
				fetchImpl: this.fetch,
			});
			this.oauth = {
				access_token: tokens.access_token,
				// A server that rotates returns a new refresh token; one that does
				// not leaves the existing one valid. Never drop it on the floor.
				refresh_token: tokens.refresh_token || this.oauth.refresh_token,
				expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
				scope: tokens.scope,
			};
			this.onTokensRefreshed(this.oauth);
			return true;
		} catch {
			return false;
		}
	}

	async whoami() {
		return this.request("/api/v1/whoami");
	}

	/** What this session's token is allowed to call — GET /api/v1/tools. */
	async listTools() {
		return this.request("/api/v1/tools");
	}

	/**
	 * Every vendor-automation command (customers, status, ...) goes through
	 * this one call — POST /api/v1/tools/{name} — rather than each command
	 * hand-rolling its own endpoint and error shape.
	 */
	async callTool(name, args = {}) {
		return this.request(`/api/v1/tools/${name}`, { method: "POST", body: args });
	}
}
