// Real end-to-end check for the oauth-grant-simplify PR: seeds real rows in
// the actual preview DB, mints a real hashed access token the same way
// mintTokenPair does, then hits the real dev server over HTTP and observes
// dispatchTool's actual authz decision. Cleans up everything it inserted.
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
	readFileSync(".env.local", "utf8")
		.split("\n")
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
		}),
);

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const BASE = "http://127.0.0.1:9100";
const STAFF_ID = env.STAFF_USER_IDS.split(",")[0];

function hashToken(token) {
	return createHash("sha256").update(token).digest("hex");
}
function genToken() {
	return `lp_oat_${randomBytes(32).toString("hex")}`;
}

const cleanup = [];

async function mintAccessToken({ vendorId, userId, scope }) {
	const { data: auth, error: authErr } = await db
		.from("oauth_authorizations")
		.insert({ client_id: "letterprove_cli", vendor_id: vendorId, user_id: userId, scope })
		.select("id")
		.single();
	if (authErr) throw new Error(`seed authorization failed: ${authErr.message}`);
	cleanup.push(() => db.from("oauth_authorizations").delete().eq("id", auth.id));

	const token = genToken();
	const { data: tok, error: tokErr } = await db
		.from("oauth_access_tokens")
		.insert({
			token_hash: hashToken(token),
			authorization_id: auth.id,
			vendor_id: vendorId,
			scope,
			expires_at: new Date(Date.now() + 3600_000).toISOString(),
		})
		.select("id")
		.single();
	if (tokErr) throw new Error(`seed access token failed: ${tokErr.message}`);
	cleanup.push(() => db.from("oauth_access_tokens").delete().eq("id", tok.id));

	return token;
}

async function callTool(token, name, body = {}) {
	const res = await fetch(`${BASE}/api/v1/tools/${name}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

function check(label, cond, detail) {
	console.log(`${cond ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
	if (!cond) process.exitCode = 1;
}

async function main() {
	// Real vendor with a real member, from actual DB state — not fabricated.
	const { data: membership, error: memErr } = await db
		.from("vendor_members")
		.select("vendor_id, user_id")
		.limit(1)
		.maybeSingle();
	if (memErr || !membership) throw new Error(`no existing vendor_members row to test against: ${memErr?.message}`);
	console.log(`using real membership vendor_id=${membership.vendor_id} user_id=${membership.user_id}`);

	// 1. Vendor scope, real member -> dispatch should ALLOW (200/etc, not 403).
	{
		const token = await mintAccessToken({
			vendorId: membership.vendor_id,
			userId: membership.user_id,
			scope: "vendor:read",
		});
		const { status, body } = await callTool(token, "get_status");
		check("vendor:read with real membership is not denied by dispatch", status !== 403, `status=${status} body=${JSON.stringify(body)}`);
	}

	// 2. Vendor scope, NOT a member of that vendor -> dispatch should DENY (403 insufficient_scope).
	{
		const token = await mintAccessToken({
			vendorId: membership.vendor_id,
			userId: STAFF_ID, // real auth user, but not a member of this vendor
			scope: "vendor:read",
		});
		const { status, body } = await callTool(token, "get_status");
		check(
			"vendor:read WITHOUT membership is denied by dispatch (this PR's new check)",
			status === 403 && body?.error === "insufficient_scope",
			`status=${status} body=${JSON.stringify(body)}`,
		);
	}

	// 3. Staff scope, allowlisted user -> dispatch should ALLOW.
	{
		const token = await mintAccessToken({ vendorId: null, userId: STAFF_ID, scope: "staff:read" });
		const { status, body } = await callTool(token, "tier_report", {});
		check("staff:read with allowlisted user is not denied by dispatch", status !== 403, `status=${status} body=${JSON.stringify(body)}`);
	}

	// 4. Staff scope, NON-allowlisted user (a real vendor member, not staff) -> dispatch should DENY.
	//    This is the exact regression this PR must not reopen: consent no longer
	//    narrows staff:* away from a non-staff grant, so dispatch is the only thing
	//    standing between a plain vendor user and every vendor's withheld data.
	{
		const token = await mintAccessToken({ vendorId: null, userId: membership.user_id, scope: "staff:read" });
		const { status, body } = await callTool(token, "tier_report", {});
		check(
			"staff:read with a NON-staff user is denied by dispatch",
			status === 403 && body?.error === "insufficient_scope",
			`status=${status} body=${JSON.stringify(body)}`,
		);
	}
}

main()
	.catch((err) => {
		console.error("ERROR", err);
		process.exitCode = 1;
	})
	.finally(async () => {
		for (const fn of cleanup.reverse()) await fn();
		console.log(`cleaned up ${cleanup.length} seeded rows`);
	});
