"use client";

import { useState, type FormEvent } from "react";

export function OnboardingForm() {
	const [name, setName] = useState("");
	const [domain, setDomain] = useState("");
	const [category, setCategory] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		setLoading(true);
		setError(null);

		const res = await fetch("/api/vendor/onboarding", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, domain, category }),
		});

		if (res.redirected) {
			window.location.href = res.url;
			return;
		}

		if (!res.ok) {
			setLoading(false);
			const body = await res.json().catch(() => null);
			setError(body?.error || "Something went wrong. Please try again.");
			return;
		}

		window.location.href = "/vendor";
	}

	return (
		<form onSubmit={onSubmit} style={{ display: "grid", gap: "0.75rem", marginTop: "1.5rem" }}>
			<label>
				Vendor name
				<input
					type="text"
					required
					value={name}
					onChange={(e) => setName(e.target.value)}
					style={{ display: "block", width: "100%" }}
				/>
			</label>
			<label>
				Domain
				<input
					type="text"
					required
					placeholder="acme.com"
					value={domain}
					onChange={(e) => setDomain(e.target.value)}
					style={{ display: "block", width: "100%" }}
				/>
			</label>
			<p style={{ fontSize: "0.85em", color: "#666", marginTop: "-0.5rem" }}>
				Hostname only, e.g. &ldquo;acme.com&rdquo; — this must exactly match the host
				attest.js will be served from, since event collection origin-pins to it.
			</p>
			<label>
				Category
				<input
					type="text"
					required
					placeholder="customer data platforms"
					value={category}
					onChange={(e) => setCategory(e.target.value)}
					style={{ display: "block", width: "100%" }}
				/>
			</label>
			{error && <p style={{ color: "crimson" }}>{error}</p>}
			<button type="submit" disabled={loading}>
				{loading ? "Working…" : "Create vendor"}
			</button>
		</form>
	);
}
