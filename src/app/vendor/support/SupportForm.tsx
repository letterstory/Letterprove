"use client";

import { useState, type FormEvent } from "react";
import { Button, ErrorBanner, Field, Notice, Textarea } from "@/components/form";

export function SupportForm() {
	const [message, setMessage] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);
	const [loading, setLoading] = useState(false);

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		setLoading(true);
		setError(null);

		const res = await fetch("/api/vendor/support", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message }),
		});

		setLoading(false);

		if (!res.ok) {
			const body = await res.json().catch(() => null);
			setError(body?.error || "Something went wrong. Please try again.");
			return;
		}

		setMessage("");
		setSent(true);
	}

	return (
		<form onSubmit={onSubmit} className="mt-6 grid gap-4 rounded-lg border border-edge bg-panel p-6">
			<Field label="How can we help?">
				<Textarea
					required
					rows={6}
					placeholder="Tell us what's going on…"
					value={message}
					onChange={(e) => {
						setMessage(e.target.value);
						setSent(false);
					}}
				/>
			</Field>
			{error && <ErrorBanner>{error}</ErrorBanner>}
			{sent && !error && <Notice>Sent — we&apos;ll get back to you by email.</Notice>}
			<Button type="submit" disabled={loading || !message.trim()} className="w-full">
				{loading ? "Sending…" : "Send message"}
			</Button>
		</form>
	);
}
