"use client";

import { useState, type FormEvent } from "react";

export interface CustomerRow {
	id: string;
	slug: string;
	name: string;
	domain: string;
	since: string;
	tier: number;
	verified: boolean;
	features: string[];
	consent: "named" | "anonymous";
}

interface Props {
	initialCustomers: CustomerRow[];
	features: readonly string[];
}

// Empty new-customer form state. `consent` starts on "anonymous" — the
// private option — never "named". A customer who hasn't been asked hasn't
// consented, and guessing wrong here means publishing a third party's
// identity without permission. See src/lib/fixtures/vendors.ts's consentOf().
function emptyForm() {
	return { slug: "", name: "", domain: "", since: "", consent: "anonymous" as "named" | "anonymous" };
}

export function CustomersManager({ initialCustomers, features }: Props) {
	const [customers, setCustomers] = useState<CustomerRow[]>(initialCustomers);
	const [form, setForm] = useState(emptyForm());
	const [error, setError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [editingSlug, setEditingSlug] = useState<string | null>(null);

	async function onAdd(e: FormEvent) {
		e.preventDefault();
		setError(null);
		setAdding(true);

		const res = await fetch("/api/vendor/customers", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(form),
		});

		setAdding(false);

		if (!res.ok) {
			const body = await res.json().catch(() => null);
			setError(body?.error ?? `Failed to add customer (${res.status})`);
			return;
		}

		const { customer } = (await res.json()) as { customer: CustomerRow };
		setCustomers((prev) => [...prev, customer]);
		setForm(emptyForm());
	}

	async function onDelete(slug: string) {
		if (!confirm(`Remove ${slug}? This can't be undone.`)) return;

		setError(null);
		const res = await fetch(`/api/vendor/customers/${encodeURIComponent(slug)}`, { method: "DELETE" });

		if (!res.ok && res.status !== 404) {
			const body = await res.json().catch(() => null);
			setError(body?.error ?? `Failed to remove ${slug} (${res.status})`);
			return;
		}

		setCustomers((prev) => prev.filter((c) => c.slug !== slug));
	}

	async function onSaveEdit(slug: string, patch: Partial<CustomerRow>) {
		setError(null);
		const res = await fetch(`/api/vendor/customers/${encodeURIComponent(slug)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(patch),
		});

		if (!res.ok) {
			const body = await res.json().catch(() => null);
			setError(body?.error ?? `Failed to update ${slug} (${res.status})`);
			return;
		}

		const { customer } = (await res.json()) as { customer: CustomerRow };
		setCustomers((prev) => prev.map((c) => (c.slug === slug ? customer : c)));
		setEditingSlug(null);
	}

	return (
		<div style={{ marginTop: "2rem" }}>
			{error && <p style={{ color: "crimson" }}>{error}</p>}

			<table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2rem" }}>
				<thead>
					<tr>
						<th style={{ textAlign: "left" }}>Name</th>
						<th style={{ textAlign: "left" }}>Domain</th>
						<th style={{ textAlign: "left" }}>Since</th>
						<th style={{ textAlign: "left" }}>Consent</th>
						<th style={{ textAlign: "left" }}>Features</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{customers.length === 0 && (
						<tr>
							<td colSpan={6}>No customers yet.</td>
						</tr>
					)}
					{customers.map((c) =>
						editingSlug === c.slug ? (
							<EditRow
								key={c.id}
								customer={c}
								features={features}
								onCancel={() => setEditingSlug(null)}
								onSave={(patch) => onSaveEdit(c.slug, patch)}
							/>
						) : (
							<tr key={c.id}>
								<td>{c.name}</td>
								<td>{c.domain}</td>
								<td>{c.since}</td>
								<td>{c.consent}</td>
								<td>{c.features.join(", ") || "—"}</td>
								<td>
									<button type="button" onClick={() => setEditingSlug(c.slug)}>
										Edit
									</button>{" "}
									<button type="button" onClick={() => onDelete(c.slug)}>
										Delete
									</button>
								</td>
							</tr>
						),
					)}
				</tbody>
			</table>

			<h2>Add a customer</h2>
			<form onSubmit={onAdd} style={{ display: "grid", gap: "0.75rem", maxWidth: 360 }}>
				<label>
					Slug
					<input
						required
						value={form.slug}
						onChange={(e) => setForm({ ...form, slug: e.target.value })}
						style={{ display: "block", width: "100%" }}
					/>
				</label>
				<label>
					Name
					<input
						required
						value={form.name}
						onChange={(e) => setForm({ ...form, name: e.target.value })}
						style={{ display: "block", width: "100%" }}
					/>
				</label>
				<label>
					Domain
					<input
						required
						value={form.domain}
						onChange={(e) => setForm({ ...form, domain: e.target.value })}
						style={{ display: "block", width: "100%" }}
					/>
				</label>
				<label>
					Since (e.g. 2024-08)
					<input
						required
						value={form.since}
						onChange={(e) => setForm({ ...form, since: e.target.value })}
						style={{ display: "block", width: "100%" }}
					/>
				</label>
				<label>
					Consent
					<select
						value={form.consent}
						onChange={(e) =>
							setForm({ ...form, consent: e.target.value as "named" | "anonymous" })
						}
						style={{ display: "block", width: "100%" }}
					>
						<option value="anonymous">Anonymous (default — no consent to be named yet)</option>
						<option value="named">Named (they&rsquo;ve agreed to be identified)</option>
					</select>
				</label>
				<button type="submit" disabled={adding}>
					{adding ? "Adding…" : "Add customer"}
				</button>
			</form>
		</div>
	);
}

function EditRow({
	customer,
	features,
	onCancel,
	onSave,
}: {
	customer: CustomerRow;
	features: readonly string[];
	onCancel: () => void;
	onSave: (patch: Partial<CustomerRow>) => void;
}) {
	const [name, setName] = useState(customer.name);
	const [domain, setDomain] = useState(customer.domain);
	const [since, setSince] = useState(customer.since);
	const [consent, setConsent] = useState<"named" | "anonymous">(customer.consent);
	const [selectedFeatures, setSelectedFeatures] = useState<string[]>(customer.features);

	function toggleFeature(f: string) {
		setSelectedFeatures((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));
	}

	return (
		<tr>
			<td>
				<input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
			</td>
			<td>
				<input value={domain} onChange={(e) => setDomain(e.target.value)} style={{ width: "100%" }} />
			</td>
			<td>
				<input value={since} onChange={(e) => setSince(e.target.value)} style={{ width: "100%" }} />
			</td>
			<td>
				<select value={consent} onChange={(e) => setConsent(e.target.value as "named" | "anonymous")}>
					<option value="anonymous">Anonymous</option>
					<option value="named">Named</option>
				</select>
			</td>
			<td>
				{features.map((f) => (
					<label key={f} style={{ display: "block", fontSize: "0.85em" }}>
						<input
							type="checkbox"
							checked={selectedFeatures.includes(f)}
							onChange={() => toggleFeature(f)}
						/>{" "}
						{f}
					</label>
				))}
			</td>
			<td>
				<button
					type="button"
					onClick={() => onSave({ name, domain, since, consent, features: selectedFeatures })}
				>
					Save
				</button>{" "}
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
			</td>
		</tr>
	);
}
