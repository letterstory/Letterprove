/**
 * Who counts as the agentic-read billing service — Letterstory's own
 * unattended invoicing cron, and nobody else.
 *
 * This is deliberately NOT staff (`src/lib/staff/allowlist.ts`). Staff
 * capability is attached to a real human this deployment has named, precisely
 * so cross-vendor access stays attributable to a person and revocable without
 * Letterprove ever having to trust a bare "staff: true" from the other side of
 * the seam (see oauth-auth.ts). Reusing that mechanism for an unattended job
 * would mean either impersonating a human who didn't make the call, or
 * widening isStaffUser to cover a non-human — both wrong for the same reason.
 *
 * So this is its own narrow allowlist of exactly one id, checked the same
 * fails-closed way: an unset AGENTIC_READ_BILLING_SERVICE_ID means nothing
 * this deployment does grants `billing:read` to anyone, however requested.
 * The id itself is not a secret — it identifies WHICH caller this is, the
 * shared service secret (`isLetterstoryCaller`) is what proves the caller is
 * actually Letterstory's backend at all.
 */
export function isAgenticReadBillingService(userId: string | null | undefined): boolean {
	const configured = process.env.AGENTIC_READ_BILLING_SERVICE_ID?.trim();
	if (!configured || !userId) return false;
	return userId === configured;
}
