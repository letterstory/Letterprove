// Command dispatch for the Letterprove CLI.
//
// Step 1 of the CLI was auth and nothing else: login, logout, whoami, config.
// This is step 2 — customers and status — built over the same Bearer token,
// routed through the one server-side seam (POST /api/v1/tools/{name}, see
// src/lib/tools/registry.ts) rather than each command growing its own
// endpoint. Vendor creation is not here: it is a one-time, cookie-session
// signup step a token cannot bootstrap itself (see the registry's own
// comment on why it has no tool entry).

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
  letterprove login [--url <url>]              Sign in through your browser
  letterprove logout                           Revoke this machine's session and clear it
  letterprove whoami                           Show which vendor the saved session acts for
  letterprove config                           Show the resolved configuration
  letterprove tools                            List what this session's token can call

  letterprove status                           Is this vendor receiving events right now?

  letterprove customers list                   List this vendor's customers
  letterprove customers create --slug <slug> --name <name> --domain <domain> --since <since> [--consent named]
  letterprove customers update <slug> [--name <name>] [--domain <domain>] [--since <since>] [--consent named|anonymous] [--features a,b,c]
  letterprove customers delete <slug>

  letterprove staff tiers [--vendor <slug>]     Per-domain tier status (every vendor, or one)
  letterprove staff record <vendor> <domain>    Turn an observed domain into a customer record

  letterprove help

Flags:
  --json                                       Machine-readable output, where supported

Environment:
  LETTERPROVE_API_URL                          Override the API base URL
  LETTERPROVE_CONFIG_HOME                      Override the home dir holding .letterprove/
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
	return { command: positional[0], positional, flags };
}

function defaultIo() {
	return {
		log: (m) => process.stdout.write(`${m}\n`),
		error: (m) => process.stderr.write(`${m}\n`),
	};
}

/** A saved-but-unverified session should still let a silent refresh persist. */
function newClient(config) {
	return new LetterproveClient({
		url: config.url,
		oauth: config.oauth,
		onTokensRefreshed: (oauth) => writeConfigFile({ ...readConfigFile(), oauth }),
	});
}

export async function run(argv, { io = defaultIo() } = {}) {
	const { command, positional, flags } = parseArgs(argv);
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
			case "tools":
				return await cmdTools({ config, flags, io });
			case "status":
				return await cmdStatus({ config, flags, io });
			case "customers":
				return await cmdCustomers({ config, flags, io, positional: positional.slice(1) });
			case "staff":
				return await cmdStaff({ config, flags, io, positional: positional.slice(1) });
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
	const client = newClient(config);
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

async function cmdTools({ config, flags, io }) {
	const client = newClient(config);
	const { tools } = await client.listTools();

	if (flags.json) {
		io.log(JSON.stringify(tools, null, 2));
		return 0;
	}
	for (const t of tools ?? []) {
		const mark = t.available ? " " : "x";
		io.log(`[${mark}] ${t.name.padEnd(20)} ${t.description}`);
	}
	return 0;
}

async function cmdStatus({ config, flags, io }) {
	const client = newClient(config);
	const result = await client.callTool("get_status");

	if (flags.json) {
		io.log(JSON.stringify(result, null, 2));
		return 0;
	}
	io.log(result.receiving ? `receiving events (${result.count} in the last 24h)` : "no events in the last 24h");
	return 0;
}

async function cmdCustomers({ config, flags, io, positional }) {
	const [sub, ...rest] = positional;
	const client = newClient(config);

	switch (sub) {
		case "list": {
			const { customers } = await client.callTool("list_customers");
			if (flags.json) {
				io.log(JSON.stringify(customers, null, 2));
				return 0;
			}
			if (!customers?.length) {
				io.log("(no customers)");
				return 0;
			}
			for (const c of customers) {
				io.log(`${c.slug.padEnd(24)} ${c.name.padEnd(24)} ${c.domain}`);
			}
			return 0;
		}
		case "create": {
			const args = {
				slug: flags.slug,
				name: flags.name,
				domain: flags.domain,
				since: flags.since,
				...(flags.consent ? { consent: flags.consent } : {}),
			};
			const { customer } = await client.callTool("create_customer", args);
			io.log(flags.json ? JSON.stringify(customer, null, 2) : `Created ${customer.slug}.`);
			return 0;
		}
		case "update": {
			const slug = rest[0];
			if (!slug) throw new CliError("Usage: letterprove customers update <slug> [--name ...] [--domain ...] ...");
			const args = { slug };
			if (typeof flags.name === "string") args.name = flags.name;
			if (typeof flags.domain === "string") args.domain = flags.domain;
			if (typeof flags.since === "string") args.since = flags.since;
			if (typeof flags.consent === "string") args.consent = flags.consent;
			if (typeof flags.features === "string") args.features = flags.features.split(",").map((f) => f.trim());
			const { customer } = await client.callTool("update_customer", args);
			io.log(flags.json ? JSON.stringify(customer, null, 2) : `Updated ${customer.slug}.`);
			return 0;
		}
		case "delete": {
			const slug = rest[0];
			if (!slug) throw new CliError("Usage: letterprove customers delete <slug>");
			await client.callTool("delete_customer", { slug });
			io.log(`Deleted ${slug}.`);
			return 0;
		}
		default:
			io.error(`Unknown "customers" subcommand: ${sub ?? "(none)"}\n`);
			io.error(USAGE);
			return 1;
	}
}

async function cmdStaff({ config, flags, io, positional }) {
	const [sub, ...rest] = positional;
	const client = newClient(config);

	switch (sub) {
		case "tiers": {
			const args = typeof flags.vendor === "string" ? { vendor: flags.vendor } : {};
			const result = await client.callTool("tier_report", args);
			if (flags.json) {
				io.log(JSON.stringify(result, null, 2));
				return 0;
			}
			for (const report of result.vendors ?? []) {
				io.log(
					`${report.vendor}  observed=${report.observed} attributable=${report.attributable} unpublished=${report.unpublishedEvidence} published=${report.published}`,
				);
				for (const row of report.rows) {
					io.log(`  ${row.domain.padEnd(28)} ${row.status.padEnd(20)} ${row.detail}`);
				}
			}
			if (result.unreadable?.length) {
				io.log(`(unreadable: ${result.unreadable.join(", ")})`);
			}
			return 0;
		}
		case "record": {
			const [vendor, domain] = rest;
			if (!vendor || !domain) throw new CliError("Usage: letterprove staff record <vendor> <domain>");
			const { customer } = await client.callTool("record_customer", { vendor, domain });
			io.log(flags.json ? JSON.stringify(customer, null, 2) : `Recorded ${customer.slug} (${customer.domain}) for ${vendor}.`);
			return 0;
		}
		default:
			io.error(`Unknown "staff" subcommand: ${sub ?? "(none)"}\n`);
			io.error(USAGE);
			return 1;
	}
}
