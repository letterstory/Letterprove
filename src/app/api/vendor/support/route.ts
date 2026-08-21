import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/auth/server";
import { currentVendor } from "@/lib/vendors/session";
import { sendSupportMessage } from "@/lib/support/slack";

const MAX_MESSAGE_LENGTH = 4000;

export async function POST(request: NextRequest) {
	const user = await getUser();
	if (!user) {
		return NextResponse.json({ error: "Not signed in" }, { status: 401 });
	}

	const vendor = await currentVendor();
	if (!vendor) {
		return NextResponse.json({ error: "No vendor found for this account" }, { status: 400 });
	}

	const body = await request.json().catch(() => null);
	const message = typeof body?.message === "string" ? body.message.trim() : "";

	if (!message) {
		return NextResponse.json({ error: "Message is required" }, { status: 400 });
	}
	if (message.length > MAX_MESSAGE_LENGTH) {
		return NextResponse.json({ error: `Message must be under ${MAX_MESSAGE_LENGTH} characters` }, { status: 400 });
	}

	const result = await sendSupportMessage({
		vendorName: vendor.name,
		vendorSlug: vendor.slug,
		userEmail: user.email ?? "unknown",
		message,
	});

	if (!result.ok) {
		return NextResponse.json({ error: result.error ?? "Failed to send your message" }, { status: 502 });
	}

	return NextResponse.json({ ok: true });
}
