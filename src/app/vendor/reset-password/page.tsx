"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/auth/browser";
import { AuthCard, Button, ErrorBanner, Field, TextInput } from "@/components/form";

/**
 * Reached via the recovery link's redirect through /auth/callback, which has
 * already exchanged the code for a real session (Supabase treats "recovery"
 * as a normal signed-in session, not a special intermediate state) — so this
 * page just needs to collect the new password and call updateUser.
 */
export default function VendorResetPasswordPage() {
	const router = useRouter();
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		setError(null);

		if (password !== confirm) {
			setError("Passwords don't match.");
			return;
		}

		setLoading(true);
		const supabase = createClient();
		const { error: updateError } = await supabase.auth.updateUser({ password });

		if (updateError) {
			setLoading(false);
			setError(updateError.message);
			return;
		}

		router.replace("/vendor");
		router.refresh();
	}

	return (
		<AuthCard title="Set a new password">
			<p className="mt-2 text-sm text-fog">Choose a new password for your vendor account.</p>
			<form onSubmit={onSubmit} className="mt-6 grid gap-4">
				<Field label="New password">
					<TextInput
						type="password"
						name="new-password"
						id="new-password"
						required
						minLength={6}
						autoComplete="new-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</Field>
				<Field label="Confirm password">
					<TextInput
						type="password"
						name="confirm-password"
						id="confirm-password"
						required
						minLength={6}
						autoComplete="new-password"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
					/>
				</Field>
				{error && <ErrorBanner>{error}</ErrorBanner>}
				<Button type="submit" disabled={loading} className="w-full">
					{loading ? "Working…" : "Update password"}
				</Button>
			</form>
		</AuthCard>
	);
}
