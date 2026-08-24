"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorBanner, Field, TextInput } from "@/components/form";

export function OnboardingForm() {
	const router = useRouter();
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

		router.push("/vendor");
		router.refresh();
	}

	return (
		<form onSubmit={onSubmit} className="mt-6 grid gap-4 rounded-lg border border-edge bg-panel p-6">
			<Field label="Vendor name">
				<TextInput type="text" required value={name} onChange={(e) => setName(e.target.value)} />
			</Field>
			<Field
				label="Domain"
				hint={'Hostname only, e.g. "acme.com" — this must exactly match the host attest.js will be served from, since event collection origin-pins to it.'}
			>
				<TextInput
					type="text"
					required
					placeholder="acme.com"
					value={domain}
					onChange={(e) => setDomain(e.target.value)}
				/>
			</Field>
			<Field label="Category">
				<TextInput
					type="text"
					required
					placeholder="customer data platforms"
					value={category}
					onChange={(e) => setCategory(e.target.value)}
				/>
			</Field>
			{error && <ErrorBanner>{error}</ErrorBanner>}
			<Button type="submit" disabled={loading} className="w-full">
				{loading ? "Working…" : "Create vendor"}
			</Button>
		</form>
	);
}
