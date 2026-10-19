"use client";

import Script from "next/script";
import { useSyncExternalStore } from "react";
import { LETTERVISIT_KEY, isLettervisitHost } from "@/lib/lettervisit";

/**
 * The LetterVisit (Visitors) script tag, on letterprove.com only (see lib/lettervisit). The
 * same app serves vendors' custom proof domains, so the host is checked in the browser: the tag
 * never loads on a vendor's domain. Renders nothing unless NEXT_PUBLIC_LETTERVISIT_KEY is set.
 */
const noSubscription = () => () => {};

export function Lettervisit() {
	// The browser's host, read once on the client; false on the server, so nothing renders there.
	const own = useSyncExternalStore(
		noSubscription,
		() => isLettervisitHost(window.location.hostname),
		() => false,
	);
	if (!LETTERVISIT_KEY || !own) return null;
	return (
		<Script id="lettervisit" src="https://lettervisit.com/v.js" data-key={LETTERVISIT_KEY} strategy="afterInteractive" />
	);
}
