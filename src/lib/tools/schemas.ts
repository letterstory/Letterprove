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

const consent = z.enum(["named", "anonymous"]);

/**
 * A customer as every customer-shaped tool returns it. Mirrors CustomerRow,
 * which is itself pinned to CUSTOMER_COLUMNS by columns.test.ts — but nothing
 * pins THIS to either, so `schemas.test.ts` closes that edge.
 */
const customer = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	domain: z.string(),
	since: z.string().describe("When the relationship started, as the vendor asserts it."),
	tier: z.number().int().describe("What the VENDOR claims. A ceiling on published provenance, never a floor."),
	verified: z.boolean(),
	features: z.array(z.string()),
	consent,
	countersigned_at: z
		.string()
		.nullable()
		.describe("When the customer counter-signed — the tier-4 evidence a vendor cannot forge."),
	consent_sent_to: z.string().nullable().describe("Where a live consent link went, or null if none is outstanding."),
	countersigned_by: z.string().nullable().describe("Which address approved. Recorded for audit; never published."),
	consent_declined_at: z.string().nullable().describe("When they last declined. Blocks re-asking for 30 days."),
	consent_decline_count: z.number().int().describe("How many times. One 'not now' reads differently from four."),
});

/** promoteDomain's success shape, returned by both promotion tools. */
const promotedCustomer = z.object({
	customer: z
		.object({ ok: z.literal(true), slug: z.string(), name: z.string(), domain: z.string() })
		.describe("Anonymous with a tier-1 ceiling — promoting a domain is not consent to be named."),
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
	domain: z.string().min(1).describe("Pinned by exact hostname. www.acme.com and acme.com are different answers."),
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
	attested_customers: z.number().int().describe("Counter-signed only. A customer record alone does not count."),
	companies_observed: z.number().int(),
	sessions_30d: z.number().int(),
	last_attested: z.string().nullable(),
});

export const getStatusInput = empty;
export const getStatusOutput = z.object({
	receiving: z.boolean().describe("Any event in the last 24h."),
	installed: z.boolean().describe("Has the script EVER checked in — distinguishes quiet from never installed."),
	count: z.number().int(),
});

export const getInstallSnippetInput = empty;
export const getInstallSnippetOutput = z.object({
	snippet: z.string().describe("Pointed at the origin actually serving this request, never a stored host."),
	origin: z.string(),
	publishable_key: z.string().describe("Ships in the page's HTML by design. Not a secret."),
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

export const updateVendorInput = z
	.object({
		name: z.string().optional(),
		domain: z.string().optional().describe("Changing this clears verification — the old proof does not transfer."),
		category: z.string().optional(),
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
	slug: z.string().min(1).describe("Becomes part of the published proof path."),
	name: z.string().min(1),
	domain: z.string().min(1).describe("Rejected if it is a mailbox provider or the vendor's own."),
	since: z.string().min(1),
	consent: consent.optional().describe("Defaults to anonymous. Not being asked is not consent."),
});
export const createCustomerOutput = z.object({ customer });

export const updateCustomerInput = z.object({
	slug: z.string().min(1).describe("Which customer. Not itself changeable."),
	name: z.string().optional(),
	domain: z.string().optional(),
	since: z.string().optional(),
	consent: consent.optional(),
	features: z.array(z.enum(FEATURES as unknown as [string, ...string[]])).optional(),
});
export const updateCustomerOutput = z.object({ customer });

export const deleteCustomerInput = z.object({ slug: z.string().min(1) });
export const deleteCustomerOutput = z
	.object({ deleted: z.literal(true) })
	.describe("This seam always answers with JSON, so an empty success is a flag rather than a 204.");

export const requestConsentInput = z.object({
	slug: z.string().min(1),
	contact_email: z
		.string()
		.min(1)
		.describe("Must be on the customer's own domain. That binding is what makes approval evidence."),
});
export const requestConsentOutput = z.object({
	sentTo: z.string().describe("Where it went. The link itself is never returned to the caller."),
	expiresAt: z.string(),
});

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
	status: z.string().describe("What it is blocked on: no-customer-record, consent-withheld, published…"),
	detail: z.string().describe("Written to be read by a person deciding what to do next."),
});

export const listObservedInput = empty;
export const listObservedOutput = z.object({
	observed: z.number().int().describe("Distinct domains seen in the window, whatever their kind."),
	attributable: z.number().int().describe("Of those, how many could ever name a company."),
	awaiting: z.number().int().describe("Attributable, observed, unpublished — the actionable backlog."),
	published: z.number().int(),
	domains: z.array(observedDomain),
});

export const listSnapshotsInput = z.object({
	customer: z.string().optional().describe("One customer slug, or every customer if omitted."),
});
export const listSnapshotsOutput = z.object({
	snapshots: z.array(
		z.object({
			slug: z.string(),
			length: z.number().int().describe("How many attestations are in this customer's hash chain."),
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
		.describe("False for an rk_test key. Test payments corroborate nothing, so a test key syncs but stores no evidence."),
	connected_at: z.string(),
	last_synced_at: z.string().nullable().describe("Null until sync_stripe_payments has run once against this key."),
	last_sync_error: z
		.string()
		.nullable()
		.describe("Stripe's own message, so a vendor is told 'your key expired' rather than 'sync failed'."),
	evidence_domains: z
		.number()
		.int()
		.nullable()
		.describe("Customer domains currently carrying tier-3 payment evidence. Null when the count could not be read, because a failed read is not a zero."),
});

export const connectStripeInput = z.object({
	restricted_key: z
		.string()
		.min(1)
		.describe("A Stripe RESTRICTED key (rk_live_… or rk_test_…), read scope on Subscriptions and Customers. An unrestricted sk_ or a publishable pk_ is refused, not stored."),
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
		.describe("The key and every payment evidence row it produced are gone. Customers corroborated only by Stripe drop back to what observed usage alone earns."),
});

export const syncStripePaymentsInput = empty;
export const syncStripePaymentsOutput = z.object({
	matched: z.number().int().describe("Customer domains that got payment evidence, the tier-3 population after this sync."),
	unmatched: z
		.number()
		.int()
		.describe("Subscriptions that could not be joined to an observed domain. Not a failure: a vendor's Stripe holds customers this product has never seen."),
	test_mode: z
		.boolean()
		.describe("True when a test key meant the counts above are real and NOTHING was stored. Wiring works; evidence is refused."),
	truncated: z
		.boolean()
		.describe("Stripe held more subscriptions than one sync reads, so the counts understate. Reported rather than silent."),
});

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
			members: z
				.array(z.object({ email: z.string(), role: z.string() }))
				.describe("Addresses. Nothing else in the tool surface returns these — hence staff:read."),
			customers: z.object({ total: z.number().int(), named: z.number().int() }),
			aggregate: z
				.object({ companies: z.number().int(), sessions: z.number().int(), tier: z.number().int() })
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
	assertedTier: z.number().int().nullable().describe("What the vendor claims."),
	earnedTier: z.number().int().nullable().describe("What the evidence supports right now."),
	consent: consent.nullable(),
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
			unpublishedEvidence: z.number().int(),
			published: z.number().int(),
			rows: z.array(tierRow),
		}),
	),
	unreadable: z
		.array(z.string())
		.optional()
		.describe("Vendors whose telemetry could not be read. Present only when non-empty — a failed read is not a zero."),
});
