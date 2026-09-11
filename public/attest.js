/**
 * attest.js — the client-side half of collection. See README § Collection
 * and § Event schema for the contract this implements.
 *
 * Install: copy the snippet out of the Proofs tab, which builds it from the
 * origin actually serving the page. The host is never written down.
 *
 *   <script src="{this app's origin}/attest.js" data-key="lp_live_…"></script>
 *
 * This file is `public/attest.js`, so it is served by this app at this app's
 * own origin and nowhere else. A snippet naming any other host 404s, and this
 * script is built never to break a host page, so that 404 is indistinguishable
 * from a site with no traffic: the vendor sees an empty dashboard and concludes
 * the product does not work. That has already happened twice, once for 65
 * hours. src/lib/vendors/install.ts holds the incidents and the derivation.
 *
 * Public API (fires POST /api/v1/observe on the vendor's behalf):
 *   Letterprove.identify(email)  // establishes domain, fires one "session" per page load
 *   Letterprove.signup(email)    // identifies, then fires "signup"
 *   Letterprove.login(email)     // identifies, then fires "login"
 *
 * `email` is never sent anywhere — only its domain part is, and only after
 * being split off locally. See README § "The one hard rule: domain only".
 *
 * Every public method is wrapped so nothing here can throw into the host
 * page: a vendor's product must work identically whether this script loads,
 * fails, or is missing entirely.
 */
(function () {
	"use strict";

	var scriptEl = findScriptEl();
	if (!scriptEl) return;

	var key = scriptEl.getAttribute("data-key");
	if (!key) return;

	var origin = scriptOrigin(scriptEl);
	if (!origin) return;

	var CONFIG_URL = origin + "/api/v1/config?k=" + encodeURIComponent(key);
	var OBSERVE_URL = origin + "/api/v1/observe";

	// Boot state. `cfg` and `ready`/`failed` come from the one config fetch
	// below — per README § Configuration, fails closed and is never retried
	// mid-page: a cold cache plus a failed fetch means no collection, not a
	// guess.
	var cfg = null;
	var ready = false;
	var failed = false;
	var queue = [];

	var domain = null;
	var sessionFired = false;

	function findScriptEl() {
		if (document.currentScript) return document.currentScript;
		// Fallback for async/defer loading, where currentScript is null by the
		// time this IIFE runs.
		var scripts = document.getElementsByTagName("script");
		for (var i = scripts.length - 1; i >= 0; i--) {
			if (/(^|\/)attest\.js(\?|$)/.test(scripts[i].src)) return scripts[i];
		}
		return null;
	}

	function scriptOrigin(el) {
		try {
			return new URL(el.src).origin;
		} catch {
			return null;
		}
	}

	function domainFromEmail(email) {
		if (typeof email !== "string") return null;
		var at = email.lastIndexOf("@");
		if (at < 0 || at === email.length - 1) return null;
		var d = email.slice(at + 1).trim().toLowerCase();
		return d.length ? d : null;
	}

	function send(ev) {
		if (!domain || cfg === null) return;
		var payload = {
			k: key,
			domain: domain,
			ev: ev,
			cfg: cfg,
			ts: Math.floor(Date.now() / 1000),
		};
		var body;
		try {
			body = JSON.stringify(payload);
		} catch {
			return;
		}
		try {
			if (navigator.sendBeacon && navigator.sendBeacon(OBSERVE_URL, body)) return;
		} catch {
			// fall through to fetch
		}
		try {
			fetch(OBSERVE_URL, { method: "POST", body: body, keepalive: true, credentials: "omit" }).catch(function () {});
		} catch {
			// never throw into the host page
		}
	}

	function fire(ev) {
		if (failed) return;
		if (!ready) {
			queue.push(ev);
			return;
		}
		send(ev);
	}

	function flush() {
		var pending = queue;
		queue = [];
		for (var i = 0; i < pending.length; i++) send(pending[i]);
	}

	function boot() {
		var req;
		try {
			req = fetch(CONFIG_URL, { credentials: "omit" });
		} catch {
			failed = true;
			return;
		}
		req
			.then(function (res) {
				if (!res.ok) throw new Error("config unavailable");
				return res.json();
			})
			.then(function (body) {
				if (!body || typeof body.cfg !== "number") throw new Error("malformed config");
				cfg = body.cfg;
				ready = true;
				flush();
			})
			.catch(function () {
				failed = true;
				queue = [];
			});
	}

	function identify(email) {
		try {
			var d = domainFromEmail(email);
			if (!d) return;
			domain = d;
			if (!sessionFired) {
				sessionFired = true;
				fire("session");
			}
		} catch {
			// never throw into the host page
		}
	}

	function signup(email) {
		try {
			identify(email);
			fire("signup");
		} catch {
			// never throw into the host page
		}
	}

	function login(email) {
		try {
			identify(email);
			fire("login");
		} catch {
			// never throw into the host page
		}
	}

	var api = window.Letterprove || {};
	api.identify = identify;
	api.signup = signup;
	api.login = login;
	window.Letterprove = api;

	boot();
})();
