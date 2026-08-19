"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/auth/browser";

/**
 * Sign in only. Self-service signup used to live here, and combined with an
 * absent staff allowlist it meant anyone could register and read every
 * vendor's withheld customer domains. Staff accounts are provisioned now:
 * create the Supabase user, then add its id to STAFF_USER_IDS. Removing the
 * form is not itself the fix — lib/staff/allowlist.ts is — but an internal
 * login page should not advertise a door that leads nowhere.
 */
export function StaffLoginForm({ denied }: { denied: boolean }) {
	const router = useRouter();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

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
				{denied && (
					<p style={{ color: "crimson" }}>
						This account does not have staff access. Sign in with a staff account, or ask
						an operator to add you.
					</p>
				)}
				<button type="submit" disabled={loading}>
					{loading ? "Working…" : "Sign in"}
				</button>
			</form>
		</main>
	);
}
