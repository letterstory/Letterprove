import { StaffLoginForm } from "./StaffLoginForm";

/**
 * Server wrapper so `?denied=1` — set by proxy.ts when a signed-in account is
 * not on the staff allowlist — is read where search params belong, and handed
 * to the form as a prop.
 *
 * The form was reading it from `window` in an effect, which meant setting state
 * during the first commit purely to learn something the request already knew.
 */
export default async function StaffLoginPage({
	searchParams,
}: {
	searchParams: Promise<{ denied?: string }>;
}) {
	const { denied } = await searchParams;
	return <StaffLoginForm denied={denied === "1"} />;
}
