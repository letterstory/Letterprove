/**
 * Phase-1 event schema — README § Event schema / Configuration (decided
 * 08-11, phase-1 signal list confirmed 08-11).
 *
 * `ev` is a closed enum. Deliberately no `feature`/named-event type yet:
 * shipping one now would silently pre-empt the confirmed phase-1 scope
 * (signups, logins, sessions, active accounts — nothing else). Named events
 * ride the config endpoint's `signals` registry once that's real, as a
 * phase-2 addition. "Active accounts" isn't a fourth event type — it's
 * derived server-side from session/login activity.
 */

export type EventType = "session" | "signup" | "login";

const EVENT_TYPES: readonly EventType[] = ["session", "signup", "login"];

function isEventType(value: unknown): value is EventType {
	return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

/** The config version this deploy serves. Every accepted event carries it back. */
export const CURRENT_CONFIG_VERSION = 1;

/** The wire body of `POST /v1/observe`, after JSON parsing. */
export interface ObservePayload {
	k: string;
	domain: string;
	ev: EventType;
	cfg: number;
	ts: number;
}

/**
 * Shape-validates a decoded JSON body. Returns null on anything malformed.
 *
 * The caller responds 204 either way — per Reliability, a host page never
 * sees a failure, so there's no value in a rich validation error here. This
 * only decides whether the event is trustworthy enough to log.
 */
export function parseObservePayload(body: unknown): ObservePayload | null {
	if (typeof body !== "object" || body === null) return null;
	const { k, domain, ev, cfg, ts } = body as Record<string, unknown>;

	if (typeof k !== "string" || k.length === 0) return null;
	if (typeof domain !== "string" || domain.length === 0) return null;
	if (!isEventType(ev)) return null;
	if (typeof cfg !== "number" || !Number.isFinite(cfg)) return null;
	if (typeof ts !== "number" || !Number.isFinite(ts)) return null;

	return { k, domain, ev, cfg, ts };
}
