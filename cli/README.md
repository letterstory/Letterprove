# `@letterstory/letterprove-cli`

> [!WARNING]
> **Sign-in does not currently work, so no command below can reach the server.**
>
> `letterprove login` runs a browser OAuth 2.1 flow against `/api/oauth/*`. Those endpoints
> no longer exist. Letterprove's own OAuth server was retired with the auth unification
> ([#124](https://github.com/letterstory/Letterprove/pull/124) /
> [#130](https://github.com/letterstory/Letterprove/pull/130)), which made Letterstory the
> identity authority: there is now exactly one non-browser door into the tool dispatcher,
> and it is Letterstory's backend proving itself with a shared service secret
> (`src/lib/oauth-auth.ts`). A caller holding a CLI bearer token gets a 401, and there is no
> token to hold, because nothing mints one. `GET /api/v1/tools`, which `letterprove tools`
> reads, was retired at the same time.
>
> Everything a vendor can do today happens in Letterstory's Proofs tab. This README is left
> in place because whether a vendor CLI comes back, and what it would authenticate with, is
> an open product decision rather than something to quietly delete. Read the rest of this
> page as a record of what the CLI did, not as instructions you can follow.

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

**This section describes a flow that no longer has a server behind it.** See the warning at
the top of this page. It is kept as the record of how the CLI authenticated, not as a
working procedure.

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

letterprove install                          The <script> tag to put on your site
letterprove keys rotate                      Replace your collector key — invalidates the old one immediately
letterprove vendor update [--name <name>] [--domain <domain>] [--category <category>]  Edit your vendor account
letterprove snapshots list [--customer <slug>]  Attestation chain summaries for your customers
letterprove support <message>                Send a support message to the team

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

`letterprove install` returns a snippet pointed at the server you're actually talking to
(`--url`, if you passed one) — safe to run against a local or preview deployment as well as
production. `letterprove keys rotate` mints a new collector key and invalidates the old one
immediately; every site using the old snippet stops sending events until you install the new
one. `letterprove vendor update` edits your account's own `name`/`domain`/`category` — pass
only the fields you want to change; the rest are left as-is.

Pass `--json` to any read command for machine-readable output.

Vendor creation itself is not a CLI command — it's a one-time signup step that happens in
the browser (a token can't bootstrap the vendor it belongs to). Everything after that is
scriptable.
