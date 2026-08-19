# `@letterstory/letterprove-cli`

Manage your Letterprove vendor account from your terminal. The CLI is a thin client over
the same tool dispatcher an agent would call (`POST /api/v1/tools/{name}`), so it never
drifts from the API.

## Install

Plain ESM, zero dependencies, no build step (Node ≥ 22).

```bash
npm install -g @letterstory/letterprove-cli   # puts `letterprove` on your PATH
# …or run it without installing:
npx -p @letterstory/letterprove-cli letterprove --help
```

Contributing to the CLI itself? Run it straight from a checkout instead:

```bash
cd cli
npm link                       # puts `letterprove` on your PATH, pointing at this checkout
# …or run it directly:
node cli/bin/letterprove.mjs --help
```

## Authenticate

```bash
letterprove login
# opens your browser to https://app.letterprove.com, or override with --url
```

This runs a browser-based OAuth 2.1 flow (PKCE, loopback redirect — RFC 8252). There is no
static API key: the server has exactly one non-browser credential type, and `login` is how
you get one. Tokens are saved to `~/.letterprove/config.json` (mode 600) and refresh
automatically. Run `letterprove logout` to revoke the session and forget it.

Credentials resolve from `--url`, then `LETTERPROVE_API_URL` / `LETTERPROVE_CONFIG_HOME`,
then the saved config file, then the built-in default (`https://app.letterprove.com`).

Run `letterprove whoami` to confirm which vendor and capabilities the saved session
resolves to. Run `letterprove config` to see the resolved url and config path without
making a network call.

## Commands

```
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
```

`staff` commands need `staff:read`/`staff:write` capability, which any signed-in staff
account gets — not something a vendor's own credentials carry. `letterprove login` already
requests every capability the CLI client is registered for, so a staff member logs in the
same way a vendor does; the consent screen shows only what your account is actually
eligible for.

Pass `--json` to any read command for machine-readable output.

Vendor creation itself is not a CLI command — it's a one-time signup step that happens in
the browser (a token can't bootstrap the vendor it belongs to). Everything after that is
scriptable.
