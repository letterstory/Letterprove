import { z } from "zod";
import { FEATURES } from "@/lib/fixtures/vendors";

/**
 * The argument and response contract for every tool in the registry.
 *
 * Before this, a tool's arguments lived in prose inside its own `description`
 * ("Args: slug, name, domain, since, consent?") and its response shape lived
 * nowhere at all. A caller had to read English to learn what to send, and had
 * to call the tool to learn what came back. Neither could be validated, so both
 * drifted from the handler silently and by default.
 *
 * These schemas are the single source for both halves. `defineTool` binds them
 * to the handler at compile time, `GET /api/v1/tools` advertises them, and the
 * coverage test refuses a schema that documents nothing.
 *
 * Conventions, matching Letterstory so the two services read the same way:
 *   - Inputs are closed; unknown keys are a caller's typo, not forward compat.
 *   - Outputs are open; a response contract is a lower bound, so adding a field
 *     later isn't a breaking change to the advertised schema.
 *   - `.describe()` carries the reasoning a caller actually needs, not a
 *     restatement of the field name.
 *
 * Error bodies are deliberately NOT modelled here. Every failure goes through
 * ToolResult's `{ ok: false, status, body }`, which is uniform across all 15
 * tools and documented once at the dispatcher; a per-tool error schema would be
 * fifteen copies of the same thing.
 */

const consent = z.enum(["named", "anonymous"]);

/**
 * A customer as every customer-shaped tool returns it.
 *
 * This is a THIRD copy of the row shape, after `CUSTOMER_COLUMNS` (what is
 * selected) and `CustomerRow` (what TypeScript believes). columns.test.ts pins
 * the vendor dashboard to the first of those, and does not know this file
 * exists — so nothing here is guarded by it. `schemas.test.ts` adds the missing
 * edge: every column selected must appear in this schema.
 *
 * That guard is needed in one direction specifically. A REMOVED column is
 * caught already, because dispatchTool validates real payloads and a required
 * field would go missing. An ADDED column is not: outputs are open by design,
 * so a new column simply never appears in the advertised contract and nothing
 * fails. That is exactly how `consent_sent_to` once went missing from the
 * dashboard for weeks.
 */
const customer = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	domain: z.string(),
	since: z.string().describe("When this customer started using the product, as the vendor asserts it."),
	tier: z.number().int().describe("The tier the VENDOR asserts. A ceiling on published provenance, never a floor."),
	verified: z.boolean(),
	features: z.array(z.string()),
	consent,
	countersigned_at: z
		.string()
		.nullable()
		.describe("When the customer counter-signed their own attestation — the tier-4 evidence a vendor cannot forge."),
	consent_sent_to: z.string().nullable().describe("Address a live consent link went to, or null if none is outstanding."),
	countersigned_by: z.string().nullable().describe("Which address approved. Recorded for audit; never published."),
	consent_declined_at: z
		.string()
		.nullable()
		.describe("When the customer last declined. Blocks re-asking for 30 days. Never published."),
	consent_decline_count: z.number().int().describe("How many times they have declined. One 'not now' differs from four."),
});

/* ---------------------------------------------------------------- customers */

export const listCustomersInput = z.object({});
export const listCustomersOutput = z.object({ customers: z.array(customer) });

export const createCustomerInput = z.object({
	slug: z.string().min(1).describe("URL-safe identifier. Becomes part of the published proof path."),
	name: z.string().min(1),
	domain: z.string().min(1).describe("The customer's own domain. Rejected if it is a mailbox provider or the vendor's own."),
	since: z.string().min(1),
	consent: consent
		.optional()
		.describe("Defaults to anonymous. A customer who has not been asked has not consented."),
});
export const createCustomerOutput = z.object({ customer });

export const updateCustomerInput = z.object({
	slug: z.string().min(1).describe("Which customer to update. Not itself changeable."),
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
	.describe("This seam always answers with a JSON body, so an empty success is expressed as a flag rather than a 204.");

export const requestConsentInput = z.object({
	slug: z.string().min(1),
	contact_email: z
		.string()
		.min(1)
		.describe(
			"Must be an address on that customer's own domain. This binding is what makes the approval evidence rather than the vendor's assertion.",
		),
});
export const requestConsentOutput = z.object({
	sentTo: z.string().describe("Where the link went. The link itself is never returned to the caller."),
	expiresAt: z.string(),
});

/* ------------------------------------------------------------------- vendor */

export const getStatusInput = z.object({});
export const getStatusOutput = z.object({
	receiving: z.boolean().describe("Whether any event arrived in the last 24h."),
	installed: z.boolean().describe("Whether the script has EVER checked in — distinguishes 'quiet' from 'never installed'."),
	count: z.number().int(),
});

export const getInstallSnippetInput = z.object({});
export const getInstallSnippetOutput = z.object({
	snippet: z.string().describe("The <script> tag to paste. Pointed at the origin actually serving this request."),
	origin: z.string(),
});

export const rotateKeyInput = z.object({});
export const rotateKeyOutput = z
	.object({ key: z.string() })
	.describe("The new key. The previous one stops working immediately — every existing install must be updated.");

export const verifyDomainInput = z.object({});
/**
 * Two branches, because a failed DNS lookup is not a failed request. DNS is
 * allowed to be briefly unreachable, and a lookup that fails must never
 * un-verify a vendor who already proved control — so the unverified branch
 * still reports the prior `verified` state and hands back what to publish.
 */
export const verifyDomainOutput = z.union([
	z.object({
		verified: z.literal(true),
		checked: z.literal(true),
		message: z.string(),
		verified_at: z.string(),
	}),
	z.object({
		verified: z.boolean().describe("The vendor's PRIOR verification state, preserved across a failed lookup."),
		checked: z.literal(false),
		message: z.string(),
		record: z.string().describe("The TXT record to publish."),
		hosts: z.array(z.string()).describe("Hostnames checked, in order."),
	}),
]);

export const updateVendorInput = z
	.object({
		name: z.string().optional(),
		domain: z.string().optional().describe("Changing this clears domain verification — the old proof does not transfer."),
		category: z.string().optional(),
	})
	.describe("At least one field is required.");
export const updateVendorOutput = z.object({
	vendor: z.object({
		slug: z.string(),
		name: z.string(),
		domain: z.string(),
		category: z.string(),
		domain_verified_at: z
			.string()
			.nullable()
			.describe("Null after a domain change — verification does not transfer to a domain nobody has proven control of."),
	}).describe("The vendor account as it stands after the update, not just the fields that changed."),
});

export const submitSupportRequestInput = z.object({
	message: z.string().min(1).describe("Delivered to the team with the caller's vendor and account attached."),
});
export const submitSupportRequestOutput = z.object({
	ok: z.literal(true).describe("The message reached the team. A delivery failure is a 502, not an ok:false body."),
});

/* ---------------------------------------------------------------- observed */

const observedDomain = z.object({
	domain: z.string(),
	kind: z.string().describe("Whether this domain can ever name a company (e.g. company, mailbox provider, unknown)."),
	sessions: z.number().int(),
	signups: z.number().int(),
	logins: z.number().int(),
	customer: z.string().nullable().describe("The customer record this maps to, when one exists."),
	status: z.string().describe("What this domain is blocked on: no-customer-record, consent-withheld, published, and so on."),
	detail: z.string().describe("Written to be read by a person deciding what to do next."),
});

export const listObservedInput = z.object({});
export const listObservedOutput = z.object({
	observed: z.number().int().describe("Distinct domains seen in the window, whatever their kind."),
	attributable: z.number().int().describe("Of those, how many could ever name a company."),
	awaiting: z.number().int().describe("Attributable, observed, and not published — the actionable backlog."),
	published: z.number().int(),
	domains: z.array(observedDomain),
});

export const listSnapshotsInput = z.object({
	customer: z.string().optional().describe("Restrict to one customer slug. Every customer if omitted."),
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

/* ------------------------------------------------------------------- staff */

export const recordCustomerInput = z.object({
	vendor: z.string().min(1).describe("Vendor slug. Staff tools act across vendors, so this is not taken from the principal."),
	domain: z.string().min(1),
});
export const recordCustomerOutput = z.object({
	customer: z
		.object({
			ok: z.literal(true),
			slug: z.string().describe("Derived from the domain's registrable name, and expected to be reviewed by a human."),
			name: z.string(),
			domain: z.string(),
		})
		.describe("The created record. Anonymous with a tier-1 ceiling — promoting a domain is not consent to be named."),
});

const tierRow = z.object({
	domain: z.string(),
	kind: z.string(),
	sessions: z.number().int(),
	signups: z.number().int(),
	logins: z.number().int(),
	customer: z.string().nullable(),
	assertedTier: z.number().int().nullable().describe("What the vendor claims."),
	earnedTier: z.number().int().nullable().describe("What the evidence actually supports right now."),
	consent: consent.nullable(),
	status: z.string(),
	detail: z.string(),
});

export const tierReportInput = z.object({
	vendor: z.string().optional().describe("Vendor slug. Every vendor if omitted."),
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
		.describe(
			"Vendors whose telemetry could not be read. Present only when non-empty — a failed read is not the same as zero observed, and must not be reported as one.",
		),
});
