// Command dispatch for the Letterprove CLI.
//
// Step 1 of the CLI is auth and nothing else: login, logout, whoami, config.
// The install/configure/manage surface comes later, over the same Bearer token
// this file obtains — the point of shipping auth alone first is that the
// credential path is proven before anything is built on top of it.

import {
	LetterproveClient,
	resolveConfig,
	readConfigFile,
	writeConfigFile,
	clearConfigFile,
	configPath,
	CliError,
} from "./client.mjs";
import { browserLogin, revokeToken } from "./oauth.mjs";

const USAGE = `letterprove — Letterprove from your terminal

Usage:
  letterprove login [--url <url>]   Sign in through your browser
  letterprove logout               Revoke this machine's session and clear it
  letterprove whoami               Show which vendor the saved session acts for
  letterprove config               Show the resolved configuration
  letterprove help

Environment:
  LETTERPROVE_API_URL              Override the API base URL
  LETTERPROVE_CONFIG_HOME          Override the home dir holding .letterprove/
`;

function parseArgs(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const [name, inline] = arg.slice(2).split("=");
			if (inline !== undefined) {
				flags[name] = inline;
			} else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
				flags[name] = argv[++i];
			} else {
				flags[name] = true;
			}
		} else {
			positional.push(arg);
		}
	}
	return { command: positional[0], flags };
}

function defaultIo() {
	return {
		log: (m) => process.stdout.write(`${m}\n`),
		error: (m) => process.stderr.write(`${m}\n`),
	};
}

export async function run(argv, { io = defaultIo() } = {}) {
	const { command, flags } = parseArgs(argv);
	const url = typeof flags.url === "string" ? flags.url : undefined;
	const config = resolveConfig({ url });

	try {
		switch (command) {
			case "login":
				return await cmdLogin({ config, flags, io });
			case "logout":
				return await cmdLogout({ config, io });
			case "whoami":
				return await cmdWhoami({ config, flags, io });
			case "config":
				return cmdConfig({ config, flags, io });
			case undefined:
			case "help":
				io.log(USAGE);
				return 0;
			default:
				io.error(`Unknown command: ${command}\n`);
				io.error(USAGE);
				return 1;
		}
	} catch (err) {
		if (err instanceof CliError) {
			io.error(err.message);
			return 1;
		}
		throw err;
	}
}

async function cmdLogin({ config, flags, io }) {
	const tokens = await browserLogin({ url: config.url, io });
	const oauth = {
		access_token: tokens.access_token,
		refresh_token: tokens.refresh_token,
		expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		scope: tokens.scope,
	};
	// Merge onto whatever is already on disk so login doesn't truncate other
	// keys. The URL is only persisted when it was given explicitly — otherwise a
	// saved config would pin today's default forever.
	const path = writeConfigFile({
		...readConfigFile(),
		oauth,
		...(typeof flags.url === "string" ? { url: config.url } : {}),
	});
	io.log(`Saved credentials to ${path}`);

	// Verify without failing the save: a saved-but-unverified session is still
	// usable once the network comes back.
	try {
		const client = new LetterproveClient({ url: config.url, oauth });
		const { vendor } = await client.whoami();
		io.log(`Signed in to ${config.url} as ${vendor?.name ?? "(unknown vendor)"}.`);
	} catch (err) {
		io.error(`Saved, but could not verify the session: ${err.message}`);
	}
	return 0;
}

async function cmdLogout({ config, io }) {
	if (config.oauth?.access_token) {
		// Both halves, in that order: revoking only the access token would leave a
		// refresh token that can mint a new one, which is not a logout.
		await revokeToken({ url: config.url, token: config.oauth.access_token });
		if (config.oauth.refresh_token) {
			await revokeToken({ url: config.url, token: config.oauth.refresh_token });
		}
	}
	io.log(`Cleared credentials at ${clearConfigFile()}`);
	return 0;
}

async function cmdWhoami({ config, flags, io }) {
	const client = new LetterproveClient({
		url: config.url,
		oauth: config.oauth,
		// Re-read on write so a silent refresh preserves any other keys already in
		// the file (a pinned url) instead of truncating it to just the tokens.
		onTokensRefreshed: (oauth) => writeConfigFile({ ...readConfigFile(), oauth }),
	});
	const result = await client.whoami();

	if (flags.json) {
		io.log(JSON.stringify(result, null, 2));
		return 0;
	}
	io.log(`url:          ${config.url}`);
	io.log(`vendor:       ${result.vendor?.name ?? "(unknown)"} (${result.vendor?.slug ?? "-"})`);
	io.log(`capabilities: ${(result.capabilities ?? []).join(", ") || "(none)"}`);
	return 0;
}

function cmdConfig({ config, flags, io }) {
	const value = {
		url: config.url,
		session: config.oauth ? "(browser session)" : "(none)",
		config_file: configPath(),
	};
	if (flags.json) {
		io.log(JSON.stringify(value, null, 2));
	} else {
		io.log(`url:         ${value.url}`);
		io.log(`session:     ${value.session}`);
		io.log(`config file: ${value.config_file}`);
	}
	return 0;
}
