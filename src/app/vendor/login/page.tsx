"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/auth/browser";
import { AuthCard, Button, ErrorBanner, Field, Notice, TextInput } from "@/components/form";

type Mode = "signin" | "signup" | "reset";

export default function VendorLoginPage() {
	const router = useRouter();
	const [mode, setMode] = useState<Mode>("signin");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const isSignup = mode === "signup";
	const isReset = mode === "reset";

	// The intended destination from ?redirect=, read client-side so no
	// useSearchParams Suspense boundary is needed at build time.
	function destination() {
		const redirect = new URLSearchParams(window.location.search).get("redirect") || "/vendor";
		return redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/vendor";
	}

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		setLoading(true);
		setError(null);
		setNotice(null);

		const supabase = createClient();
		const dest = destination();

		if (isReset) {
			const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
				redirectTo: `${window.location.origin}/auth/callback?redirect=${encodeURIComponent("/vendor/reset-password")}`,
			});

			setLoading(false);
			if (resetError) {
				setError(resetError.message);
				return;
			}

			setMode("signin");
			setNotice("If an account exists for that email, we've sent a password reset link.");
			return;
		}

		if (isSignup) {
			const { data, error: signUpError } = await supabase.auth.signUp({
				email: email.trim(),
				password,
				options: {
					emailRedirectTo: `${window.location.origin}/auth/callback?redirect=${encodeURIComponent(dest)}`,
				},
			});

			if (signUpError) {
				setLoading(false);
				setError(signUpError.message);
				return;
			}

			if (data.session) {
				router.replace(dest);
				router.refresh();
				return;
			}

			setLoading(false);
			setPassword("");
			setMode("signin");
			setNotice("Account created. Check your email for a confirmation link, then sign in.");
			return;
		}

		const { error: signInError } = await supabase.auth.signInWithPassword({
			email: email.trim(),
			password,
		});

		if (signInError) {
			setLoading(false);
			setError(signInError.message);
			return;
		}

		router.replace(dest);
		router.refresh();
	}

	return (
		<AuthCard title="Letterprove for vendors">
			<p className="mt-2 text-sm text-fog">
				{isReset
					? "Enter your email and we'll send you a link to reset your password."
					: isSignup
						? "Create an account to start publishing attested proof."
						: "Sign in to your vendor account."}
			</p>
			<form onSubmit={onSubmit} className="mt-6 grid gap-4">
				<Field label="Email">
					<TextInput
						type="email"
						required
						autoComplete="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
					/>
				</Field>
				{!isReset && (
					<Field label="Password">
						<TextInput
							type="password"
							required
							minLength={6}
							autoComplete={isSignup ? "new-password" : "current-password"}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>
					</Field>
				)}
				{!isReset && mode === "signin" && (
					<button
						type="button"
						onClick={() => {
							setMode("reset");
							setError(null);
							setNotice(null);
						}}
						className="justify-self-end text-xs text-fog hover:text-mint"
					>
						Forgot password?
					</button>
				)}
				{error && <ErrorBanner>{error}</ErrorBanner>}
				{notice && <Notice>{notice}</Notice>}
				<Button type="submit" disabled={loading} className="w-full">
					{loading ? "Working…" : isReset ? "Send reset link" : isSignup ? "Create account" : "Sign in"}
				</Button>
				<button
					type="button"
					onClick={() => {
						setMode(isSignup || isReset ? "signin" : "signup");
						setError(null);
						setNotice(null);
					}}
					className="text-center text-sm text-fog hover:text-mint"
				>
					{isReset ? "Back to sign in" : isSignup ? "Have an account? Sign in" : "Need an account? Sign up"}
				</button>
			</form>
		</AuthCard>
	);
}
