"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/auth/browser";
import { AuthCard, Button, ErrorBanner, Field, Notice, TextInput } from "@/components/form";

type Mode = "signin" | "signup";

export default function VendorLoginPage() {
	const router = useRouter();
	const [mode, setMode] = useState<Mode>("signin");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const isSignup = mode === "signup";

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
				{isSignup ? "Create an account to start publishing attested proof." : "Sign in to your vendor account."}
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
				{error && <ErrorBanner>{error}</ErrorBanner>}
				{notice && <Notice>{notice}</Notice>}
				<Button type="submit" disabled={loading} className="w-full">
					{loading ? "Working…" : isSignup ? "Create account" : "Sign in"}
				</Button>
				<button
					type="button"
					onClick={() => {
						setMode(isSignup ? "signin" : "signup");
						setError(null);
						setNotice(null);
					}}
					className="text-center text-sm text-fog hover:text-mint"
				>
					{isSignup ? "Have an account? Sign in" : "Need an account? Sign up"}
				</button>
			</form>
		</AuthCard>
	);
}
