/**
 * visit.js — the Visitors script: AI agents and people on a vendor's site.
 * Attestation (sign-ins for the proof) is a separate script, attest.js.
 *
 * Install: the Visitors snippet from get_script (`visitors_snippet`):
 *
 *   <script src="https://lettervisit.com/v.js" data-key="lp_live_…"></script>
 *
 * lettervisit.com/v.js is a rewrite to this file, and lettervisit.com's
 * /api/v1/config and /api/v1/agent-visit rewrite to this app's routes, so the
 * origin is read off this script's own src exactly as attest.js does: served
 * straight from this app it talks to this app, served through lettervisit.com
 * it talks through lettervisit.com.
 *
 * What it does, per the config's `modules` (src/lib/vendors/script.ts):
 *   agent_visitors  when the page is rendered by an automated browser —
 *                   navigator.webdriver set, or a user-agent naming an agent —
 *                   one beacon per page load to POST /api/v1/agent-visit with
 *                   only the key, the path and that flag. Ordinary visitors
 *                   send nothing. See src/lib/agents/visits.ts.
 *   human_visitors  the config carries `visitors.pixel` only then, and this
 *                   script loads the visitor-identification pixel. Nothing it
 *                   identifies passes through this script: see
 *                   src/lib/vendors/visitors.ts.
 *
 * No identify, no sign-ins: that is attest.js's job.
 *
 * Dedupe with attest.js: this script sets `window.__lettervisit = true`
 * before anything else. attest.js reads it and then sends no agent beacon and
 * loads no pixel, so a site running both scripts counts each visit once. On
 * top of that, whichever script sends the agent beacon first sets
 * `window.__letterAgentSent`, so the order the two load in cannot double it.
 *
 * Add `data-debug` to the tag to see, in the console, the boot, the config
 * answer and what was sent. Nothing here may throw into the host page.
 */
(function () {
	"use strict";

	try {
		if (window.__lettervisit) return; // a second copy of the tag
		window.__lettervisit = true;
	} catch {
		return;
	}

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
			if (c) (warn ? c.warn : c.info).call(c, "[Visitors] " + msg);
		} catch {
			// never throw into the host page
		}
	}

	var CONFIG_URL = origin + "/api/v1/config?k=" + encodeURIComponent(key) + "&s=visit";
	var AGENT_VISIT_URL = origin + "/api/v1/agent-visit";
	// Same small test as attest.js: the server classifies from the real
	// user-agent, this only decides whether a page is worth one beacon.
	var AGENT_UA = /chatgpt|gptbot|oai-searchbot|claude|anthropic|perplexity|headlesschrome|bot\b|crawler|spider/i;

	function findScriptEl() {
		if (document.currentScript) return document.currentScript;
		var scripts = document.getElementsByTagName("script");
		for (var i = scripts.length - 1; i >= 0; i--) {
			if (/(^|\/)(visit|v)\.js(\?|$)/.test(scripts[i].src)) return scripts[i];
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
			if (window.__letterAgentSent) return;
			window.__letterAgentSent = true;
			log("automated browser; agent visit sent");
			beacon(AGENT_VISIT_URL, JSON.stringify({ k: key, path: location.pathname, client: true, webdriver: webdriver }));
		} catch {
			// never throw into the host page
		}
	}

	/**
	 * The visitor-identification pixel, loaded exactly as Letter's own sites
	 * load it, once. Skipped on localhost and preview hosts, and when the page
	 * already runs it. The global and element names are the pixel's own and
	 * must stay as they are.
	 */
	var PIXEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
	function loadVisitorPixel(pixel) {
		try {
			var customerId = String(pixel.customer_id || "");
			var profileId = String(pixel.profile_id || "");
			if (!PIXEL_ID.test(customerId) || !PIXEL_ID.test(profileId)) return;
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
			log("visitor identification loaded");
		} catch {
			// never throw into the host page
		}
	}

	function boot() {
		var req;
		log("loaded on " + window.location.hostname + ", checking the key");
		try {
			req = fetch(CONFIG_URL, { credentials: "omit" });
		} catch {
			log("couldn't reach Visitors; nothing will be sent from this page", true);
			return;
		}
		req
			.then(function (res) {
				if (!res.ok) throw new Error(res.status === 404 ? "the key isn't recognised (check data-key)" : "config unavailable (" + res.status + ")");
				return res.json();
			})
			.then(function (body) {
				if (!body || typeof body.cfg !== "number") throw new Error("malformed config");
				var m = body.modules && typeof body.modules === "object" ? body.modules : {};
				log("key accepted");
				// An older cached answer without `modules` keeps agent visits on, as attest.js does.
				if (m.agent_visitors !== false) agentView();
				if (body.visitors && body.visitors.pixel) loadVisitorPixel(body.visitors.pixel);
			})
			.catch(function (e) {
				log("not collecting on this page: " + (e && e.message ? e.message : "config failed"), true);
			});
	}

	try {
		boot();
	} catch {
		// never throw into the host page
	}
})();
