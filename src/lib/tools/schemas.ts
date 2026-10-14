import { z } from "zod";
import { FEATURES } from "@/lib/fixtures/vendors";

/**
 * What every tool accepts and what it returns.
 *
 * These are not documentation. Nothing serves them: `GET /api/v1/tools` was
 * retired with the CLI in #124, so there is no discovery surface to advertise
 * to and no JSON Schema projection here. They exist to be ENFORCED —
 * `defineTool` makes a missing one a compile error, and `dispatchTool`
 * validates every non-production success against its own outputSchema, which
 * turns registry.test.ts's existing cases into conformance tests.
 *
 * That is the more useful half of the idea anyway. A published schema that
 * drifts is a lie told confidently; a schema the dispatcher checks is a schema
 * that cannot drift without a test going red.
 *
 * Error bodies are deliberately unmodelled. Every failure goes through
 * ToolResult's uniform `{ ok: false, status, body }`, documented once at the
 * dispatcher; twenty-one per-tool error schemas would be twenty-one copies of
 * one shape.
 */

/**
 * A customer on the vendor's PRIVATE list, as every customer-shaped tool
 * returns it. Nothing here is ever published: Letterprove attests the vendor,
 * in counts, and names no customer (README decision 30). The list is the
 * vendor's own bookkeeping. Mirrors CustomerRow,
 * which is itself pinned to CUSTOMER_COLUMNS by columns.test.ts — but nothing
 * pins THIS to either, so `schemas.test.ts` closes that edge.
 */
const customer = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	domain: z.string(),
	since: z.string().describe("When the relationship started, as the vendor asserts it."),
	tier: z
		.number()
		.int()
		.describe("LEGACY, ignored. Nobody sets a tier: the published tier is derived from evidence at publish time (DNS proof, observed sign-ins, settled Stripe invoices). Read it from the attestation or get_proof_summary."),
	verified: z.boolean().describe("LEGACY, ignored, for the same reason as `tier`."),
	features: z.array(z.string()).describe("The vendor's own note. Never published."),
});

/** promoteDomain's success shape, returned by both promotion tools. */
const promotedCustomer = z.object({
	customer: z
		.object({ ok: z.literal(true), slug: z.string(), name: z.string(), domain: z.string() })
		.describe("Added to the vendor's private list. Nothing about it is published."),
});

const empty = z.object({});

/* ------------------------------------------------------------- pre-vendor */

export const findVendorByOrgInput = empty;
/**
 * A union, because "this org has no vendor" is an ordinary answer rather than
 * an error — it is the state of every workspace that has never published.
 */
export const findVendorByOrgOutput = z.union([
	z.object({ linked: z.literal(false) }),
	z.object({ linked: z.literal(true), slug: z.string(), domain: z.string() }),
]);

export const createVendorInput = z.object({
	name: z.string().min(1),
	domain: z.string().min(1).describe("Your company domain. Sign-ins on it and on any host beneath it (app., www.) are counted."),
	contact_email: z.string().optional().describe("Where Letterprove emails you if your proof breaks. Usually the person setting it up."),
});
export const createVendorOutput = z.object({
	linked: z.literal(true),
	slug: z.string(),
	domain: z.string(),
});

/* ---------------------------------------------------------------- vendor */

export const getProofSummaryInput = empty;
export const getProofSummaryOutput = z.object({
	slug: z.string().describe("Used to build the public proof URL."),
	tier: z.number().int(),
	tier_name: z.string().describe("What the tier means, so a caller need not carry its own ladder."),
	companies_observed: z.number().int(),
	sessions_30d: z.number().int(),
	last_attested: z.string().nullable(),
});

export const getStatusInput = empty;
export const getStatusOutput = z.object({
	receiving: z.boolean().describe("Any event in the last 24h."),
	installed: z.boolean().describe("Has the script EVER checked in — distinguishes quiet from never installed."),
	count: z.number().int(),
	published: z.boolean().describe("Whether this vendor's proofs are public. Collection runs either way."),
	published_at: z.string().nullable().describe("When they went public. Null while private."),
	listed: z
		.boolean()
		.describe(
			"Whether the proof appears in Letterprove's listings (discovery, sitemap, llms.txt). False = unlisted: still served at its URL, never enumerated, marked noindex. Presentation only; the signed document is the same.",
		),
	ever_received_at: z
		.string()
		.nullable()
		.describe("The first event ever accepted. Use it, not `receiving`, to decide whether setup is done: a quiet day doesn't undo a working install."),
	last_received_at: z.string().nullable().describe("The latest accepted event in the last 35 days."),
	rejected_origins: z
		.array(
			z.object({
				host: z.string().describe("Where dropped events came from, e.g. staging.acme.com."),
				events_24h: z.number().int(),
				last_at: z.string(),
				addable: z.boolean().describe("True when adding this host (with its own DNS record) would accept it."),
				reason: z
					.enum(["development", "needs_proof", "other_company"])
					.describe("development: localhost or a preview host, never counted. needs_proof: a sibling of your verified domain, add it as a host. other_company: a different domain."),
			}),
		)
		.describe("Events dropped in the last 24h because of where they came from. Hosts beneath your DNS-verified domain are accepted automatically and never appear here."),
	domain_proof: z
		.enum(["none", "site", "dns"])
		.describe(
			"How your domain is proven. none: nothing proven, proof publishes as 'Domain not verified' at tier 0. site: Letterprove found attest.js with your key on site_verified_url; 'Site verified', tier 1 at most. dns: your TXT record; tiers 1 and 3, Stripe and the logo wall.",
		),
	domain_verified: z.boolean().describe("True only when the domain is proven by DNS (domain_proof dns)."),
	site_verified_at: z.string().nullable().describe("When attest.js with your key was last found on site_verified_url. Null when not site-verified."),
	site_verified_url: z.string().nullable().describe("The page site proof was found on, re-checked daily."),
});

/**
 * Publication, both directions. No arguments in either: the vendor is the
 * caller's own, resolved from the principal, so there is nothing to tamper
 * with — and publishing is an intentional act rather than a boolean somebody
 * can flip the wrong way in a single call.
 */
export const publishProofsInput = empty;
export const publishProofsOutput = z.object({
	published: z.literal(true),
	published_at: z.string(),
	slug: z.string().describe("For building the now-live /proofs and /attest URLs."),
});

export const setProofListingInput = z.object({
	listed: z.boolean().describe("true lists the proof in Letterprove's directory; false unlists it (still served at its URL)."),
});
export const setProofListingOutput = z.object({
	listed: z.boolean().describe("The listing state now in effect."),
	note: z.string().describe("What listing or unlisting changes, and that the signed attestation does not."),
});

export const unpublishProofsInput = empty;
export const unpublishProofsOutput = z.object({
	published: z.literal(false),
	note: z
		.string()
		.describe(
			"Unpublishing stops serving; it cannot un-fetch. Anything already retrieved while public stays valid and signed.",
		),
});

export const getInstallSnippetInput = empty;
export const getInstallSnippetOutput = z.object({
	snippet: z.string().describe("Pointed at the origin actually serving this request, never a stored host."),
	origin: z.string(),
	publishable_key: z.string().describe("Ships in the page's HTML by design. Not a secret."),
	badge: z
		.object({
			html: z.string().describe("Self-contained footer link: \"Attested and proven by Letterprove\". Loads nothing; inherits the footer's colour."),
			href: z.string().describe("The vendor's public proof page."),
			live: z.boolean().describe("True once the vendor is published. Before that the proof page is a 404, so do not show the badge."),
		})
		.describe("The footer badge a vendor adds to their site once published."),
	recipes: z
		.object({
			stub: z.string().describe("Script tag plus the one-line stub that keeps identify calls made before the script loads."),
			nextjs: z.string(),
			plain_js: z.string(),
			clerk: z.string(),
			auth0: z.string(),
			supabase: z.string(),
		})
		.describe("Where to call Letterprove.identify(email) after sign-in, per stack. Only the domain after the @ leaves the browser."),
	agent_kit: z
		.object({
			footer_html: z.string().describe("A low-profile footer link: \"For agents: view attested customer proof\"."),
			llms_txt: z.string().describe("A \"## Customer evidence\" section to add to your /llms.txt."),
			json_ld: z.string().describe("A <script type=\"application/ld+json\"> Organization block linking your proof, for your homepage."),
		})
		.describe("Three snippets for your own site so AI assistants reading it find your proof. Add them once your proofs are published."),
});

export const rotateKeyInput = empty;
export const rotateKeyOutput = z
	.object({ key: z.string() })
	.describe("The old key stops working immediately; every existing install must be updated.");

export const verifyDomainInput = empty;
/**
 * Two branches, because a failed DNS lookup is not a failed request. DNS may be
 * briefly unreachable, and a lookup that fails must never cost a vendor
 * verification they already earned — so the unverified branch still reports the
 * PRIOR state and hands back what to publish.
 */
export const verifyDomainOutput = z.union([
	z.object({
		domain: z.string(),
		verified: z.literal(true),
		checked: z.literal(true),
		message: z.string(),
		verified_at: z.string(),
	}),
	z.object({
		domain: z.string(),
		verified: z.boolean().describe("The PRIOR verification state, preserved across a failed lookup."),
		checked: z.literal(false),
		message: z.string(),
		record: z.string(),
		hosts: z.array(z.string()),
	}),
]);

export const verifySiteInput = z.object({
	url: z
		.string()
		.optional()
		.describe(
			"An https page on your domain (or a host beneath it) whose HTML carries your Letterprove script, e.g. https://app.acme.com/login. Defaults to the page that last verified, else https://<your domain>/.",
		),
});
export const verifySiteOutput = z.object({
	verified: z.boolean().describe("Whether site proof stands now. A failed check never clears an earlier proof; the daily re-check does."),
	domain_proof: z.enum(["none", "site", "dns"]),
	checked_url: z.string().describe("The page this check fetched."),
	reason: z.string().describe("What was found, in plain words."),
	site_verified_at: z.string().nullable(),
	site_verified_url: z.string().nullable(),
});

export const updateVendorInput = z
	.object({
		name: z.string().optional(),
		domain: z.string().optional().describe("Changing this clears verification — the old proof does not transfer."),
		category: z.string().optional(),
		contact_email: z
			.string()
			.nullable()
			.optional()
			.describe("Where Letterprove emails you if your proof breaks. Empty or null clears it."),
	})
	.describe("At least one field is required.");
export const updateVendorOutput = z.object({
	vendor: z
		.object({
			slug: z.string(),
			name: z.string(),
			domain: z.string(),
			category: z.string(),
			domain_verified_at: z.string().nullable(),
			contact_email: z.string().nullable().optional(),
		})
		.describe("The account as it stands after the update, not only the fields that changed."),
});

export const submitSupportRequestInput = z.object({
	message: z.string().min(1).describe("Delivered with the caller's vendor and account attached."),
});
export const submitSupportRequestOutput = z.object({
	ok: z.literal(true).describe("Reached the team. A delivery failure is a 502, not an ok:false body."),
});

/* -------------------------------------------------------------- customers */

export const listCustomersInput = empty;
export const listCustomersOutput = z.object({ customers: z.array(customer) });

export const createCustomerInput = z.object({
	slug: z.string().min(1).describe("An identifier on your private list. Never published."),
	name: z.string().min(1),
	domain: z.string().min(1).describe("Rejected if it is a mailbox provider or the vendor's own."),
	since: z.string().min(1),
});
export const createCustomerOutput = z.object({ customer });

export const updateCustomerInput = z.object({
	slug: z.string().min(1).describe("Which customer. Not itself changeable."),
	name: z.string().optional(),
	domain: z.string().optional(),
	since: z.string().optional(),
	features: z.array(z.enum(FEATURES as unknown as [string, ...string[]])).optional(),
});
export const updateCustomerOutput = z.object({ customer });

export const deleteCustomerInput = z.object({ slug: z.string().min(1) });
export const deleteCustomerOutput = z
	.object({ deleted: z.literal(true) })
	.describe("This seam always answers with JSON, so an empty success is a flag rather than a 204.");

export const recordObservedInput = z.object({
	domain: z.string().min(1).describe("Must already be observed for this vendor; promotion cannot invent evidence."),
});
export const recordObservedOutput = promotedCustomer;

/* --------------------------------------------------------------- observed */

const observedDomain = z.object({
	domain: z.string(),
	kind: z.string().describe("Whether this domain could ever name a company."),
	sessions: z.number().int(),
	signups: z.number().int(),
	logins: z.number().int(),
	customer: z.string().nullable(),
	status: z
		.string()
		.describe("How it counts in your attestation: observed (in companies_observed), not-attributable (excluded), no-observation (on your list, nothing observed)."),
	detail: z.string().describe("Written to be read by a person deciding what to do next."),
});

export const listObservedInput = empty;
export const listObservedOutput = z.object({
	observed: z.number().int().describe("Distinct domains seen in the window, whatever their kind."),
	attributable: z.number().int().describe("Of those, how many could ever name a company."),
	awaiting: z.number().int().describe("Observed companies counted in your attestation without Stripe corroboration."),
	published: z.number().int().describe("Observed companies counted in your attestation (companies_observed). Counts only; no domain is published."),
	paying: z.number().int().describe("Retired 2026-10-14: always 0. Payments are no longer read; Stripe only confirms your business."),
	domains: z.array(observedDomain),
});

export const listSnapshotsInput = z.object({
	customer: z.string().optional().describe("One customer slug, or every customer if omitted."),
});
export const listSnapshotsOutput = z.object({
	snapshots: z.array(
		z.object({
			slug: z.string(),
			length: z.number().int().describe("How many attestations are in this customer's retired hash chain (frozen up to 2026-10-13)."),
			current: z.object({
				published_at: z.string(),
				verified: z.boolean(),
				sessions_30d: z.number().int(),
				features: z.array(z.string()),
			}),
		}),
	),
});

/* ----------------------------------------------------------------- stripe */

/**
 * A live Stripe connection, as a caller may see it.
 *
 * `last4` is the one thing here derived from the key, and it is deliberate:
 * it is four characters of a value Stripe itself prints in its own dashboard,
 * and without it a vendor with two Stripe accounts cannot tell which key is
 * connected. Nothing else about the credential leaves the server: not the
 * key, not a masked form of it, not its length (see
 * src/lib/stripe/credentials.ts, which decrypts only to make an outbound call).
 */
const stripeConnection = z.object({
	connected: z.literal(true),
	last4: z.string().describe("The key's last four characters, the same suffix Stripe shows. Never more than that."),
	livemode: z
		.boolean()
		.describe("False for an rk_test key. A test key can read the account but never verifies the business."),
	connected_at: z.string(),
	last_synced_at: z.string().nullable().describe("When the account was last read successfully (hourly, or refresh_stripe_business)."),
	last_sync_error: z
		.string()
		.nullable()
		.describe("Stripe's own message, so a vendor is told 'your key expired' rather than 'sync failed'."),
	business: z
		.object({
			verified: z.boolean().describe("Stripe has verified the business: the account can accept payments, which Stripe allows only after checking the legal entity, the people behind it and a bank account. False for a test key."),
			name: z.string().nullable().describe("The business name the account shows."),
			country: z.string().nullable().describe("Two-letter country of the account."),
			website: z.string().nullable().describe("Host of the business website on the account."),
			website_matches_domain: z.boolean().describe("Whether that website is on your domain."),
		})
		.nullable()
		.describe("What your Stripe account says about your business, as last read. Null until it has been read. Letterprove reads nothing about payments."),
	account: z
		.object({
			id: z.string().describe("The Stripe account the key belongs to."),
			domains: z.array(z.string()).describe("Domains the account publishes about itself: business website, support URL or email, account email."),
			checked_at: z.string().nullable(),
		})
		.nullable()
		.describe("The account behind the key, as last read. Null until it has been read. It only counts as yours when one of these domains is yours, or staff approved the account."),
});

export const connectStripeInput = z.object({
	restricted_key: z
		.string()
		.min(1)
		.describe("A Stripe RESTRICTED key (rk_live_… or rk_test_…) with one permission: Accounts read (connected_account_read). Letterprove reads only which business the account is (whether Stripe verified it, its name, country and website), never payments. One of the domains the account publishes must share your domain. An unrestricted sk_ or a publishable pk_ is refused, not stored."),
});
/**
 * The connection, never an echo of the argument.
 *
 * This is the only tool that takes a secret, and the output contract is where
 * that gets enforced: there is no field here a key could be returned in, so
 * neither a handler change nor dispatchTool's own output validation (which
 * puts the offending body into a thrown error) can leak one by accident.
 */
export const connectStripeOutput = stripeConnection;

export const getStripeConnectionInput = empty;
export const getStripeConnectionOutput = z.union([
	z
		.object({ connected: z.literal(false) })
		.describe("The ordinary state of every vendor that has not connected Stripe, not an error."),
	stripeConnection,
]);

export const disconnectStripeInput = empty;
export const disconnectStripeOutput = z.object({
	disconnected: z
		.literal(true)
		.describe("The key and what the account said about your business are gone. The proof no longer shows a Stripe-verified business, so it drops to tier 1 if it was at tier 3."),
});

export const setStripeAccountOverrideInput = z.object({
	vendor: z.string().min(1).describe("Vendor slug."),
	clear: z.boolean().optional().describe("Remove the override. The account is then checked against the vendor's domain again."),
	stripe_account_id: z
		.string()
		.regex(/^acct_[A-Za-z0-9]+$/)
		.optional()
		.describe("The Stripe account to approve. Defaults to the account behind the vendor's connected key, as last read."),
	reason: z.string().min(10).max(500).optional().describe("Required when setting: why this account may verify a vendor on a different domain."),
});
export const setStripeAccountOverrideOutput = z.object({
	vendor: z.string(),
	override: z
		.object({ stripe_account_id: z.string(), at: z.string(), by: z.string().nullable(), reason: z.string().nullable() })
		.nullable()
		.describe("The approved account, who approved it and why. Null after clearing: the account is checked against the vendor's domain again from the next sync."),
});

export const syncStripePaymentsInput = empty;
export const syncStripePaymentsOutput = z.object({
	bound: z.boolean().describe("Whether the account is yours: one of the domains it publishes shares your domain, or staff approved it."),
	verified: z.boolean().describe("Whether Stripe has verified the business (the account can accept payments). False for a test key."),
	test_mode: z.boolean().describe("True for a test key: the account is read, but the business never counts as verified."),
	warning: z.string().optional().describe("Why the account doesn't count as yours, when it was read but didn't match."),
});
export const refreshStripeBusinessInput = syncStripePaymentsInput;
export const refreshStripeBusinessOutput = syncStripePaymentsOutput;

/* ------------------------------------------------------------------ staff */

export const recordCustomerInput = z.object({
	vendor: z.string().min(1).describe("Staff tools act across vendors, so this is not taken from the principal."),
	domain: z.string().min(1),
});
export const recordCustomerOutput = promotedCustomer;

export const collectionHealthInput = empty;
export const collectionHealthOutput = z.object({
	vendors: z.array(
		z.object({
			vendor: z.string(),
			domain: z.string(),
			customers: z.number().int(),
			lastEventAt: z.string().nullable(),
			hoursSinceLastEvent: z.number().nullable(),
			events24h: z.number().int(),
			events7d: z.number().int(),
			events30d: z.number().int(),
			status: z
				.string()
				.describe("reporting | silent | installed | never. 'silent' is the shape both real outages took."),
		}),
	),
});

export const vendorRosterInput = empty;
export const vendorRosterOutput = z.object({
	vendors: z.array(
		z.object({
			slug: z.string(),
			name: z.string(),
			domain: z.string(),
			category: z.string(),
			key: z.string(),
			customers: z.object({ total: z.number().int() }).describe("The vendor's private customer list. Never published."),
			published_at: z
				.string()
				.nullable()
				.describe("When this vendor's proofs went public, or null while private. See findPublishedVendor()."),
			aggregate: z
				.object({ companies: z.number().int(), paying: z.number().int(), sessions: z.number().int(), tier: z.number().int() })
				.nullable()
				.describe("What the vendor-level attestation claims, or null if it publishes nothing."),
		}),
	),
});

const tierRow = z.object({
	domain: z.string(),
	kind: z.string(),
	sessions: z.number().int(),
	signups: z.number().int(),
	logins: z.number().int(),
	customer: z.string().nullable(),
	earnedTier: z.number().int().nullable().describe("What the evidence supports right now."),
	status: z.string(),
	detail: z.string(),
});

export const tierReportInput = z.object({
	vendor: z.string().optional().describe("One vendor slug, or every vendor if omitted."),
});
export const tierReportOutput = z.object({
	generated_at: z.string(),
	vendors: z.array(
		z.object({
			vendor: z.string(),
			observed: z.number().int(),
			attributable: z.number().int(),
			unpublishedEvidence: z.number().int().describe("Observed companies without payment evidence."),
			published: z.number().int().describe("Observed companies counted in the vendor attestation."),
			paying: z.number().int().describe("Retired 2026-10-14: always 0. Payments are no longer read."),
			rows: z.array(tierRow),
		}),
	),
	unreadable: z
		.array(z.string())
		.optional()
		.describe("Vendors whose telemetry could not be read. Present only when non-empty — a failed read is not a zero."),
});

export const agenticReadBillingInput = z.object({
	billing_month: z
		.string()
		.optional()
		.describe("YYYY-MM-01. Defaults to the previous calendar month — the one that has stopped accumulating reads."),
});
export const agenticReadBillingOutput = z.object({
	billing_month: z.string(),
	vendors: z.array(
		z.object({
			vendor: z.string(),
			org_id: z
				.string()
				.nullable()
				.describe("This vendor's Letterstory org (vendors.letterstory_org_id), or null if never linked — unbillable."),
			read_count: z.number().int(),
			tier2_reads: z.number().int(),
			tier3_reads: z.number().int(),
			amount_cents: z.number().int(),
		}),
	),
});

export const getReadUsageInput = empty;
const monthUsage = z.object({
	billing_month: z.string().describe("First of the month, YYYY-MM-DD (UTC)."),
	reads: z.number().int().describe("AI-agent reads of this vendor's signed proofs in the month."),
	tier2_reads: z.number().int(),
	tier3_reads: z.number().int(),
	amount_cents: z.number().int().describe("What the month comes to under `pricing`. Billed monthly by Letterstory."),
});
export const getReadUsageOutput = z.object({
	current: monthUsage.extend({
		counted_at: z
			.string()
			.nullable()
			.describe("When the month-to-date count was last computed (daily). Null if no read has been counted yet."),
	}),
	previous: monthUsage,
	pricing: z.object({
		free_reads: z.number().int(),
		tier2_ceiling: z.number().int(),
		tier2_rate_cents: z.number().int(),
		tier3_rate_cents: z.number().int(),
	}),
});

// ---------------------------------------------------------------- custom domain

/** What a vendor's proof domain looks like right now. One shape for set, check and get. */
export const customDomainStatus = z.object({
	domain: z.string().nullable().describe("The proof hostname (e.g. proof.acme.com), or null when none is set."),
	url: z.string().nullable().describe("https:// URL of the proof page on that hostname."),
	dns: z
		.object({ type: z.literal("CNAME"), name: z.string(), value: z.string() })
		.nullable()
		.describe("The one record the vendor adds at their DNS provider."),
	extra_records: z
		.array(z.object({ type: z.string(), domain: z.string(), value: z.string() }))
		.describe("Further records Vercel asks for, only when the hostname is claimed by another Vercel account."),
	configured: z.boolean().describe("DNS points at us."),
	verified: z.boolean().describe("Vercel accepts the hostname, so it serves it over HTTPS."),
	published: z.boolean().describe("The vendor's proofs are public. Until they are, the hostname answers 404."),
	live: z.boolean().describe("configured, verified and published: the page is up on the vendor's domain."),
	verified_at: z.string().nullable().describe("When we last saw it configured and verified."),
	message: z.string().describe("One plain sentence on what to do next."),
});

export const setCustomDomainInput = z.object({
	domain: z.string().min(1).describe("A subdomain of your verified domain, e.g. proof.acme.com or success.acme.com."),
});
export const setCustomDomainOutput = customDomainStatus;
export const checkCustomDomainInput = empty;
export const checkCustomDomainOutput = customDomainStatus;
export const getCustomDomainInput = empty;
export const getCustomDomainOutput = customDomainStatus;
export const removeCustomDomainInput = empty;
export const removeCustomDomainOutput = z.object({
	removed: z.boolean().describe("False when there was no proof domain to remove."),
	domain: z.string().nullable().describe("The hostname that stopped serving your proof page."),
});

// ------------------------------------------------------------- hosts

export const hostStatus = z.object({
	host: z.string().describe("A hostname events may come from, e.g. app.acme.com."),
	proof: z
		.enum(["under_verified_domain", "own_dns"])
		.describe(
			"under_verified_domain: sits below your verified domain, so the same DNS record proves it. own_dns: a sibling or parent on the same registrable domain, which needs its own record.",
		),
	accepted: z.boolean().describe("Whether /v1/observe accepts events from this host right now."),
	verified_at: z.string().nullable().describe("When an own_dns host's record last checked out; null for hosts under your domain or still waiting."),
	added_at: z.string(),
	record: z.string().nullable().describe("The TXT value to add, while an own_dns host is still waiting on it."),
	record_hosts: z.array(z.string()).describe("Where that record may go: on the host itself or on the registrable domain."),
	message: z.string(),
});
export const addHostInput = z.object({
	host: z
		.string()
		.min(1)
		.describe("Another hostname on your verified registrable domain that runs attest.js, e.g. app.acme.com or www.acme.com. Re-run it to re-check a host's DNS record."),
});
export const addHostOutput = hostStatus;
export const removeHostInput = z.object({ host: z.string().min(1) });
export const removeHostOutput = z.object({ removed: z.boolean().describe("False when that host was not on the list."), host: z.string() });
export const listHostsInput = empty;
export const listHostsOutput = z.object({
	domain: z.string().describe("Your verified domain. Always accepted while verified."),
	hosts: z.array(hostStatus),
});

/*
 * ----------------------------------------------------------------- posthog
 *
 * Read only. Letterprove never sends events into a vendor's PostHog; it reads
 * which company domains the project has identified people from, as history.
 */
const posthogConnection = z.object({
	connected: z.literal(true),
	last4: z.string().describe("The personal API key's last four characters. Never more than that."),
	api_host: z.string().describe("The PostHog instance read, e.g. https://us.posthog.com."),
	project_id: z.string(),
	connected_at: z.string(),
	last_synced_at: z.string().nullable().describe("Null until sync_posthog has run once against this key. The sync also runs daily."),
	last_sync_error: z.string().nullable().describe("PostHog's own message, or ours, from the last failed read."),
	host_events_30d: z
		.number()
		.int()
		.nullable()
		.describe("Events in the last 30 days on your verified domain or accepted hosts. Zero means this project doesn't track your product, and its history is not published."),
	companies: z.number().int().describe("Company domains PostHog has identified people from (free mail and unattributable domains excluded)."),
	active_companies_30d: z.number().int().describe("Of those, how many had activity in the last 30 days."),
	since: z.string().nullable().describe("When PostHog first saw a person from any of them."),
	domains_excluded: z.number().int().nullable().describe("Identified domains that are not companies: free mail, ours, malformed."),
	truncated: z.boolean().describe("True when the project has more identified domains than one read returns; counts are a floor."),
	published: z
		.boolean()
		.describe("Whether this history appears on your proof as reported_history. It is labelled vendor-reported and never changes your tier."),
	unpublished_reason: z.string().nullable().describe("Why it isn't published, when it isn't."),
});

export const connectPosthogInput = z.object({
	personal_api_key: z
		.string()
		.min(1)
		.describe("A PostHog PERSONAL API key (phx_…) with the query:read scope and access to the project. A project key (phc_) can only send events and is refused. Read only: Letterprove never writes to PostHog."),
	project_id: z.string().regex(/^\d{1,12}$/).describe("The PostHog project id (the number in your project URL)."),
	api_host: z
		.string()
		.optional()
		.describe("Your PostHog instance: us.posthog.com (default), eu.posthog.com, or a self-hosted https host."),
});
export const connectPosthogOutput = posthogConnection;

export const getPosthogConnectionInput = empty;
export const getPosthogConnectionOutput = z.union([z.object({ connected: z.literal(false) }), posthogConnection]);

export const syncPosthogInput = empty;
export const syncPosthogOutput = posthogConnection;

export const disconnectPosthogInput = empty;
export const disconnectPosthogOutput = z.object({
	disconnected: z.literal(true).describe("The key and all history read with it are gone."),
});

/*
 * --------------------------------------------------------------- logo wall
 *
 * Opt-in logo verification (README decision 36). Private shape: every listed
 * company with its status. Only the attestation's `logos` block is public, and
 * it names only companies on the vendor's page AND observed.
 */
const logoStatus = z.enum(["active", "not_observed"]);
const logoWall = z.object({
	configured: z.literal(true),
	page_url: z.string().describe("Your public logo wall, on your verified domain or an accepted host."),
	checked_at: z.string().nullable().describe("When the page was last fetched and matched. Re-checked daily."),
	check_error: z.string().nullable().describe("Why the last check failed, when it did."),
	total: z.number().int().describe("Companies you listed."),
	on_page: z.number().int().describe("Of those, how many were found on the page."),
	verified: z.number().int().describe("On the page and observed signing in over the last 30 days. Only these are named on your proof."),
	published: z.boolean().describe("Whether the logos block is on your proof now: needs a check in the last two days and a verified domain."),
	companies: z.array(
		z.object({
			name: z.string(),
			domain: z.string(),
			on_page: z.boolean(),
			status: logoStatus.describe("active: observed signing in, last 30 days. not_observed: no sign-ins seen."),
		}),
	),
});

export const setLogoWallInput = z.object({
	page_url: z.string().min(1).describe("The https page on your own site that shows these logos, e.g. https://yourcompany.com/customers."),
	companies: z
		.array(z.object({ name: z.string().min(1), domain: z.string().min(1) }))
		.min(1)
		.max(200)
		.describe("The companies on that page, by name and company domain. Only ones found on the page and observed by Letterprove are named on your proof."),
});
export const setLogoWallOutput = logoWall;
export const getLogoWallInput = empty;
export const getLogoWallOutput = z.union([z.object({ configured: z.literal(false) }), logoWall]);
export const clearLogoWallInput = empty;
export const clearLogoWallOutput = z.object({ cleared: z.literal(true).describe("The list is gone; the proof stops naming any company at the next snapshot.") });

// ---------------------------------------------------------------- scripts

const scriptModules = z.object({
	proofs: z.boolean().describe("Sign-ins observed by attest.js: the evidence behind your proof."),
});

export const getScriptInput = empty;
export const getScriptOutput = z.object({
	key: z.string().describe("The publishable key in the script tag. Not a secret."),
	snippet: getInstallSnippetOutput.shape.snippet.describe("Legacy alias of proofs_snippet."),
	proofs_snippet: z.string().describe("The Letterprove tag, attest.js: sign-ins for the proof. Pair it with identify calls (recipes). Attestation only: agent visits and visitor identification are the separate Visitors product."),
	recipes: getInstallSnippetOutput.shape.recipes,
	agent_kit: getInstallSnippetOutput.shape.agent_kit,
	modules: scriptModules,
	status: z.object({
		script_seen_at: z.string().nullable().describe("First time the script tag loaded on a page."),
		proofs_script_seen_at: z.string().nullable().describe("First time attest.js loaded on a page, recorded once."),
		last_script_seen_at: z.string().nullable().describe("Most recent load we saw. Coarse: the config is cached for minutes."),
		first_signin_at: z.string().nullable().describe("First sign-in counted for your proof."),
		domain_verified: z.boolean(),
	}),
});

export const setScriptModulesInput = z.object({
	proofs: z.boolean().optional().describe("Whether attest.js collects sign-ins."),
});
export const setScriptModulesOutput = getScriptOutput;

// ---------------------------------------------------------------- proof display

const displaySections = z.object({
	sessions: z.boolean(),
	reported_history: z.boolean(),
	logos: z.boolean(),
	stripe_business: z.boolean().describe("The business Stripe verified behind your Stripe account: name, country, website."),
	observed_since: z.boolean(),
	hosts: z.boolean(),
	growth: z.boolean().describe("Companies observed per month, last six months."),
	retention: z.boolean().describe("Of the companies observed 90 to 60 days ago, how many were also observed in the last 30 days."),
	logo_names: z.boolean().describe("Name the verified companies from your logo wall, or show only the counts."),
});

export const getProofDisplayInput = empty;
export const getProofDisplayOutput = z.object({
	sections: displaySections.describe("True means shown on your public proof. A hidden section is simply left out; the proof says nothing about it."),
	locked: z.array(z.string()).describe("Always shown: domain, tier, companies observed, verify link."),
});

export const setProofDisplayInput = z.object({
	sections: displaySections.partial().describe("Only the sections you pass change."),
});
export const setProofDisplayOutput = getProofDisplayOutput;
