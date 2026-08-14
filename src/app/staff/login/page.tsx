"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/auth/browser";

type Mode = "signin" | "signup";

export default function StaffLoginPage() {
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
		const redirect = new URLSearchParams(window.location.search).get("redirect") || "/staff";
		return redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/staff";
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
		<main style={{ maxWidth: 360, margin: "4rem auto", padding: "0 1rem" }}>
			<h1>Letterprove staff</h1>
			<form onSubmit={onSubmit} style={{ display: "grid", gap: "0.75rem", marginTop: "1.5rem" }}>
				<label>
					Email
					<input
						type="email"
						required
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						style={{ display: "block", width: "100%" }}
					/>
				</label>
				<label>
					Password
					<input
						type="password"
						required
						minLength={6}
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						style={{ display: "block", width: "100%" }}
					/>
				</label>
				{error && <p style={{ color: "crimson" }}>{error}</p>}
				{notice && <p>{notice}</p>}
				<button type="submit" disabled={loading}>
					{loading ? "Working…" : isSignup ? "Create account" : "Sign in"}
				</button>
				<button
					type="button"
					onClick={() => {
						setMode(isSignup ? "signin" : "signup");
						setError(null);
						setNotice(null);
					}}
				>
					{isSignup ? "Have an account? Sign in" : "Need an account? Sign up"}
				</button>
			</form>
		</main>
	);
}
