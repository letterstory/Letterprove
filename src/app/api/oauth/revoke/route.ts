import { NextResponse, type NextRequest } from "next/server";
import { revokeByToken } from "@/lib/oauth/core";
import { oauthErrorJson } from "@/lib/oauth/responses";
import { oauthRateLimit, oauthClientIp } from "@/lib/oauth/ratelimit";

/**
 * RFC 7009 token revocation — what `letterprove logout` calls.
 *
 * Always 200, whether or not the token existed: possession of a token is
 * sufficient authorization to revoke it, and the endpoint never confirms or
 * denies whether an unrecognized token was ever valid (RFC 7009 §2.2), which
 * would otherwise make this a free token-validity oracle.
 */
export async function POST(request: NextRequest) {
	if (!(await oauthRateLimit(`revoke:${oauthClientIp(request)}`, 60, 30))) {
		return oauthErrorJson("slow_down", "Too many requests.", 429);
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return oauthErrorJson("invalid_request", "Body must be application/x-www-form-urlencoded.");
	}

	const token = String(form.get("token") ?? "");
	if (!token) return oauthErrorJson("invalid_request", "token is required.");

	try {
		await revokeByToken(token);
	} catch {
		// Swallowed deliberately: a failed revocation must not tell the caller
		// anything about the token, and logout clears local state regardless.
	}

	return new NextResponse(null, { status: 200, headers: { "cache-control": "no-store" } });
}
