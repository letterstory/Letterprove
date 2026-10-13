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
 * Agent views (no API call needed): when the page is rendered by an automated
 * browser — navigator.webdriver set, or a user-agent naming an agent — one
 * beacon per page load goes to POST /api/v1/agent-visit carrying only the
 * key, the path and that flag. The server reads who it was from the request's
 * own headers. Ordinary visitors send nothing. See src/lib/agents/visits.ts.
 *
 * One opt-in exception to "this script only reports domains": a vendor who
 * turns on visitor identification gets the Maverick pixel loaded on their
 * site too (loadVisitorPixel below). That is a separate, vendor-private
 * product — README § Visitor identification — and nothing it sees passes
 * through this script.
 *
 * Calls made before this script loads are kept, not lost. Put this one-line
 * stub above any code that might call identify early (an auth callback that
 * runs before an async script arrives), and the calls run once it boots:
 *
 *   window.Letterprove=window.Letterprove||{q:[],identify:function(e){this.q.push(['identify',e])},login:function(e){this.q.push(['login',e])},signup:function(e){this.q.push(['signup',e])}}
 *
 * Add `data-debug` to the script tag to see, in the browser console, the
 * script booting, the config answer, each identify (domain only) and each
 * event sent. Remove it once things work.
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

	var debug = scriptEl.hasAttribute("data-debug");
	function log(msg, warn) {
		if (!debug) return;
		try {
			var c = window.console;
			if (c) (warn ? c.warn : c.info).call(c, "[Letterprove] " + msg);
		} catch {
			// never throw into the host page
		}
	}

	var CONFIG_URL = origin + "/api/v1/config?k=" + encodeURIComponent(key);
	var OBSERVE_URL = origin + "/api/v1/observe";
	var AGENT_VISIT_URL = origin + "/api/v1/agent-visit";
	// A self-identified agent or headless browser. Deliberately small: the
	// server classifies from the real user-agent, this only decides whether a
	// page is worth one beacon at all.
	var AGENT_UA = /chatgpt|gptbot|oai-searchbot|claude|anthropic|perplexity|headlesschrome|bot\b|crawler|spider/i;

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
		log("sent " + ev + " for " + domain + " from " + window.location.hostname);
		beacon(OBSERVE_URL, body);
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
		log("loaded on " + window.location.hostname + ", checking the key");
		try {
			req = fetch(CONFIG_URL, { credentials: "omit" });
		} catch {
			failed = true;
			log("couldn't reach Letterprove; nothing will be sent from this page", true);
			return;
		}
		req
			.then(function (res) {
				if (!res.ok) throw new Error(res.status === 404 ? "the key isn't recognised (check data-key)" : "config unavailable (" + res.status + ")");
				return res.json();
			})
			.then(function (body) {
				if (!body || typeof body.cfg !== "number") throw new Error("malformed config");
				cfg = body.cfg;
				ready = true;
				log("key accepted; ready" + (queue.length ? ", sending " + queue.length + " queued event(s)" : ""));
				flush();
				if (body.visitors && body.visitors.pixel) loadVisitorPixel(body.visitors.pixel);
			})
			.catch(function (e) {
				failed = true;
				queue = [];
				log("not collecting on this page: " + (e && e.message ? e.message : "config failed"), true);
			});
	}

	function beacon(url, body) {
		try {
			if (navigator.sendBeacon && navigator.sendBeacon(url, body)) return;
		} catch {
			// fall through to fetch
		}
		try {
			fetch(url, { method: "POST", body: body, keepalive: true, credentials: "omit" }).catch(function () {});
		} catch {
			// never throw into the host page
		}
	}

	function agentView() {
		try {
			var webdriver = navigator.webdriver === true;
			if (!webdriver && !AGENT_UA.test(navigator.userAgent || "")) return;
			beacon(
				AGENT_VISIT_URL,
				JSON.stringify({ k: key, path: location.pathname, client: true, webdriver: webdriver })
			);
		} catch {
			// never throw into the host page
		}
	}

	/**
	 * Visitor identification, only when the vendor turned it on (the config
	 * carries `visitors.pixel` then and never otherwise). Loads the Maverick
	 * Intelligence pixel exactly as Letter's own sites do, once. Skipped on
	 * localhost and preview hosts, and when the page already runs Maverick.
	 * Nothing it identifies passes through this script or reaches the proof:
	 * see src/lib/vendors/visitors.ts.
	 */
	var MAVERICK_ID = /^[A-Za-z0-9_-]{1,64}$/;
	function loadVisitorPixel(pixel) {
		try {
			var customerId = String(pixel.customer_id || "");
			var profileId = String(pixel.profile_id || "");
			if (!MAVERICK_ID.test(customerId) || !MAVERICK_ID.test(profileId)) return;
			var h = window.location.hostname;
			if (h === "localhost" || h === "127.0.0.1" || /\.vercel\.app$/.test(h)) return;
			if (window.maverick || document.getElementById("__maverick__")) return;
			var c = {
				customerId: customerId,
				profileId: profileId,
				cdn: "cdn.maverickintelligence.co",
				api: "api.maverickintelligence.co",
				app: "app.maverickintelligence.co",
				vector: "true",
			};
			window.maverick = { config: c, initialized: false, q: [] };
			window.maverick.identify = function () {
				window.maverick.q.push(["identify", arguments]);
			};
			var s = document.createElement("script");
			s.async = true;
			s.id = "__maverick__";
			s.src = "https://" + c.app + "/maverick-pro.min.js";
			s.setAttribute("data-customer-id", c.customerId);
			s.setAttribute("data-profile-id", c.profileId);
			s.setAttribute("data-cdn", c.cdn);
			s.setAttribute("data-api", c.api);
			s.setAttribute("data-vector", c.vector);
			var f = document.getElementsByTagName("script")[0];
			if (f && f.parentNode) f.parentNode.insertBefore(s, f);
			else (document.head || document.documentElement).appendChild(s);
		} catch {
			// never throw into the host page
		}
	}

	function identify(email) {
		try {
			var d = domainFromEmail(email);
			if (!d) {
				log("identify was called without an email address; ignored", true);
				return;
			}
			domain = d;
			log("identified a user at " + d);
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
	// Calls the page made through the stub before this script arrived.
	var early = api.q && api.q.length ? api.q.slice(0) : [];
	api.q = [];
	api.identify = identify;
	api.signup = signup;
	api.login = login;
	window.Letterprove = api;
	var calls = { identify: identify, signup: signup, login: login };
	for (var c = 0; c < early.length; c++) {
		try {
			var call = early[c];
			if (call && calls[call[0]]) calls[call[0]](call[1]);
		} catch {
			// never throw into the host page
		}
	}

	boot();
	agentView();
})();
