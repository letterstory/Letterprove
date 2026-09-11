// Config resolution and the authenticated transport for the Letterprove CLI.
//
// There is no static-API-key path here, deliberately: the server has exactly
// one non-browser credential (an OAuth access token, see src/lib/oauth-auth.ts),
// so the CLI has exactly one too. A second credential kind that the server
// cannot actually verify would be a worse failure than not having one.
//
// `url` here is LETTERSTORY's origin, not Letterprove's. Letterprove holds no
// identity of its own since the 2026-09 auth unification — every vendor tool
// is now reached through Letterstory's own OAuth-authenticated dispatcher
// (`POST /api/integrations/tools/letterprove_{name}`), which forwards to
// Letterprove using the shared service secret (see
// src/lib/letterprove/tools-client.ts in the `ls` repo). This CLI's command
// surface (customers, status, keys, …) is unchanged; only the door it walks
// through to reach it moved.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const DEFAULT_API_URL = "https://app.letterstory.com";

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

	/**
	 * There is no `/api/v1/whoami` anymore — Letterprove tracks no per-token
	 * identity of its own. The closest read is "does this org have a vendor
	 * linked at all", so that's what this reports; a session that resolves but
	 * isn't linked yet is still a valid, useful answer (not an error).
	 */
	async whoami() {
		const link = await this.callTool("find_vendor_by_org", {});
		return {
			vendor: link.linked ? { slug: link.slug, domain: link.domain } : null,
			capabilities: ["vendor:read", "vendor:write"],
		};
	}

	/**
	 * Letterprove's own tools now live inside Letterstory's manifest, named
	 * `letterprove_{name}`. This is the same unauthenticated discovery
	 * Letterstory's own CLI uses (GET /api/mcp) — filtered to just this app's
	 * tools, with the prefix stripped so every existing command here
	 * (`callTool("get_status")`, etc.) keeps working unchanged.
	 */
	async listTools() {
		const endpoint = `${this.url}/api/mcp`;
		let res;
		try {
			res = await this.fetch(endpoint, { headers: { accept: "application/json" } });
		} catch (err) {
			throw new CliError(`Could not reach ${endpoint}: ${err.message}`);
		}
		if (!res.ok) throw new CliError(`Discovery failed (HTTP ${res.status}) at ${endpoint}`);
		const doc = await res.json();
		const tools = (doc.tools ?? [])
			.filter((t) => t.name.startsWith("letterprove_"))
			.map((t) => ({ ...t, name: t.name.slice("letterprove_".length) }));
		return { tools };
	}

	/**
	 * Every vendor-automation command (customers, status, ...) goes through
	 * this one call — POST /api/integrations/tools/letterprove_{name}, the
	 * generic REST dispatcher Letterstory's own integrations already use —
	 * rather than each command hand-rolling its own endpoint and error shape.
	 */
	async callTool(name, args = {}) {
		return this.request(`/api/integrations/tools/letterprove_${name}`, { method: "POST", body: args });
	}
}
