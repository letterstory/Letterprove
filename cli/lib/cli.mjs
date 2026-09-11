// Command dispatch for the Letterprove CLI.
//
// This command surface (customers, status, keys, vendor, snapshots, support)
// is unchanged from when it was first built over Letterprove's own bearer
// tokens. What changed (2026-09) is the door it walks through to get there:
// Letterprove's own OAuth server was retired in the LS↔LP auth unification,
// so login and every tool call now go to LETTERSTORY instead (see the header
// comments in ./oauth.mjs and ./client.mjs) — this file didn't need to know.
// `staff *` commands are not yet ported to that door (Letterprove's staff
// tools are an internal surface, not part of this pass) and will 404 until
// they are; everything else works the same as before.

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

  letterprove install                          The <script> tag to put on your site
  letterprove keys rotate                      Replace your collector key — invalidates the old one immediately
  letterprove vendor update [--name <name>] [--domain <domain>] [--category <category>]  Edit your vendor account
  letterprove vendor verify                                    Check DNS for your domain-verification record
  letterprove snapshots list [--customer <slug>]  Attestation chain summaries for your customers
  letterprove support <message>                Send a support message to the team

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
  LETTERPROVE_API_URL                          Override the Letterstory base URL this CLI logs into and calls
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
			case "install":
				return await cmdInstall({ config, flags, io });
			case "keys":
				return await cmdKeys({ config, flags, io, positional: positional.slice(1) });
			case "vendor":
				return await cmdVendor({ config, flags, io, positional: positional.slice(1) });
			case "snapshots":
				return await cmdSnapshots({ config, flags, io, positional: positional.slice(1) });
			case "support":
				return await cmdSupport({ config, flags, io, positional: positional.slice(1) });
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
	if (result.vendor) {
		io.log(`vendor:       ${result.vendor.slug} (${result.vendor.domain})`);
	} else {
		io.log(`vendor:       (not linked yet — link one from Letterstory's Proofs setup)`);
	}
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
		io.log(`${t.name.padEnd(20)} ${t.description ?? ""}`);
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

async function cmdInstall({ config, flags, io }) {
	const client = newClient(config);
	const result = await client.callTool("get_install_snippet");

	if (flags.json) {
		io.log(JSON.stringify(result, null, 2));
		return 0;
	}
	io.log(result.snippet);
	return 0;
}

async function cmdKeys({ config, flags, io, positional }) {
	const [sub] = positional;
	const client = newClient(config);

	switch (sub) {
		case "rotate": {
			const { key } = await client.callTool("rotate_key");
			if (flags.json) {
				io.log(JSON.stringify({ key }, null, 2));
				return 0;
			}
			io.log(`New key: ${key}`);
			io.log('The old key stopped working immediately. Run "letterprove install" for the updated snippet and update every site that uses it.');
			return 0;
		}
		default:
			io.error(`Unknown "keys" subcommand: ${sub ?? "(none)"}\n`);
			io.error(USAGE);
			return 1;
	}
}

async function cmdVendor({ config, flags, io, positional }) {
	const [sub] = positional;
	const client = newClient(config);

	switch (sub) {
		case "verify": {
			const result = await client.callTool("verify_domain", {});
			if (flags.json) {
				io.log(JSON.stringify(result, null, 2));
				return result.verified ? 0 : 1;
			}
			if (result.verified) {
				io.log(result.message ?? "Domain verified.");
				return 0;
			}
			// Non-zero, so this is usable in a script that waits for DNS.
			io.error(result.message ?? "Domain not verified.");
			if (result.record) {
				io.error(`\nAdd a TXT record at ${(result.hosts ?? []).join(" or ")} with:\n  ${result.record}`);
			}
			return 1;
		}
		case "update": {
			const args = {};
			if (typeof flags.name === "string") args.name = flags.name;
			if (typeof flags.domain === "string") args.domain = flags.domain;
			if (typeof flags.category === "string") args.category = flags.category;
			if (Object.keys(args).length === 0) {
				throw new CliError("Usage: letterprove vendor update [--name <name>] [--domain <domain>] [--category <category>]");
			}
			const { vendor } = await client.callTool("update_vendor", args);
			if (flags.json) {
				io.log(JSON.stringify(vendor, null, 2));
				return 0;
			}
			io.log(`Updated. name=${vendor.name} domain=${vendor.domain} category=${vendor.category}`);
			return 0;
		}
		default:
			io.error(`Unknown "vendor" subcommand: ${sub ?? "(none)"}\n`);
			io.error(USAGE);
			return 1;
	}
}

async function cmdSnapshots({ config, flags, io, positional }) {
	const [sub] = positional;
	const client = newClient(config);

	switch (sub) {
		case "list": {
			const args = typeof flags.customer === "string" ? { customer: flags.customer } : {};
			const { snapshots } = await client.callTool("list_snapshots", args);
			if (flags.json) {
				io.log(JSON.stringify(snapshots, null, 2));
				return 0;
			}
			if (!snapshots?.length) {
				io.log("(no snapshots)");
				return 0;
			}
			for (const s of snapshots) {
				io.log(
					`${s.slug.padEnd(24)} chain=${s.length}  published_at=${s.current.published_at}  verified=${s.current.verified}  sessions_30d=${s.current.sessions_30d}`,
				);
			}
			return 0;
		}
		default:
			io.error(`Unknown "snapshots" subcommand: ${sub ?? "(none)"}\n`);
			io.error(USAGE);
			return 1;
	}
}

async function cmdSupport({ config, flags, io, positional }) {
	const message = positional.join(" ").trim();
	if (!message) throw new CliError("Usage: letterprove support <message>");
	const client = newClient(config);
	await client.callTool("submit_support_request", { message });
	if (flags.json) {
		io.log(JSON.stringify({ ok: true }, null, 2));
		return 0;
	}
	io.log("Sent — we'll get back to you by email.");
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
