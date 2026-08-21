"use client";

import { useState, type FormEvent } from "react";
import { Button, ErrorBanner, Field, TextInput } from "@/components/form";
import { Badge, Card, EmptyState, Td, Th, TableWrap } from "@/components/ui";

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

const selectClass =
	"rounded border border-edge bg-ink px-3 py-2 text-sm text-[#e9efed] outline-none focus:border-mint";

export function CustomersManager({ initialCustomers, features }: Props) {
	const [customers, setCustomers] = useState<CustomerRow[]>(initialCustomers);
	const [form, setForm] = useState(emptyForm());
	const [error, setError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [editingSlug, setEditingSlug] = useState<string | null>(null);
	// Which row is asking "are you sure?". Inline rather than window.confirm,
	// which renders in OS chrome and ignores the page entirely.
	const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
	const [showForm, setShowForm] = useState(false);

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
		setShowForm(false);
	}

	async function onDelete(slug: string) {
		setConfirmingDelete(null);
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
		<div className="grid gap-4">
			{error && <ErrorBanner>{error}</ErrorBanner>}

			{customers.length === 0 ? (
				<EmptyState title="No customers yet">
					Add the companies you want to attest to. They start anonymous — counted in your totals
					but not named — until each one agrees to be identified.
				</EmptyState>
			) : (
				<TableWrap>
					<thead>
						<tr>
							<Th>Name</Th>
							<Th>Domain</Th>
							<Th>Since</Th>
							<Th>Consent</Th>
							<Th>Features</Th>
							<Th className="text-right">{""}</Th>
						</tr>
					</thead>
					<tbody>
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
								<tr
									key={c.id}
									className="transition-colors motion-safe:animate-[fade-in_240ms_ease-out] hover:bg-ink/40"
								>
									<Td>
										<span className="font-medium text-[#e9efed]">{c.name}</span>
										<span className="ml-2 font-mono text-xs text-fog">{c.slug}</span>
									</Td>
									<Td className="font-mono text-[13px] text-fog">{c.domain}</Td>
									<Td className="tabular-nums text-fog">{c.since}</Td>
									<Td>
										<Badge tone={c.consent === "named" ? "mint" : "neutral"}>{c.consent}</Badge>
									</Td>
									<Td className="text-fog">
										{c.features.length === 0 ? (
											<span className="text-fog/60">—</span>
										) : (
											<span className="flex flex-wrap gap-1">
												{c.features.map((f) => (
													<span
														key={f}
														className="rounded border border-edge px-1.5 py-0.5 font-mono text-[11px]"
													>
														{f}
													</span>
												))}
											</span>
										)}
									</Td>
									<Td className="text-right whitespace-nowrap">
										{confirmingDelete === c.slug ? (
											<span className="inline-flex items-center gap-2">
												<span className="text-xs text-fog">Remove?</span>
												<button
													type="button"
													onClick={() => onDelete(c.slug)}
													className="rounded border border-red-500/40 px-2 py-0.5 text-xs text-red-300 transition hover:bg-red-500/10"
												>
													Yes
												</button>
												<button
													type="button"
													onClick={() => setConfirmingDelete(null)}
													className="text-xs text-fog transition hover:text-mint"
												>
													Cancel
												</button>
											</span>
										) : (
											<span className="inline-flex items-center gap-3">
												<button
													type="button"
													onClick={() => setEditingSlug(c.slug)}
													className="text-xs text-fog transition hover:text-mint"
												>
													Edit
												</button>
												<button
													type="button"
													onClick={() => setConfirmingDelete(c.slug)}
													className="text-xs text-fog transition hover:text-red-300"
												>
													Delete
												</button>
											</span>
										)}
									</Td>
								</tr>
							),
						)}
					</tbody>
				</TableWrap>
			)}

			{showForm ? (
				<Card
					title="Add a customer"
					aside={
						<button
							type="button"
							onClick={() => setShowForm(false)}
							className="text-xs text-fog transition hover:text-mint"
						>
							Cancel
						</button>
					}
					className="motion-safe:animate-[fade-in_200ms_ease-out]"
				>
					<form onSubmit={onAdd} className="grid gap-4 sm:grid-cols-2">
						<Field label="Slug" hint="Used in the attestation URL. Lowercase, no spaces.">
							<TextInput
								required
								placeholder="acme"
								value={form.slug}
								onChange={(e) => setForm({ ...form, slug: e.target.value })}
							/>
						</Field>
						<Field label="Name">
							<TextInput
								required
								placeholder="Acme Inc"
								value={form.name}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
							/>
						</Field>
						<Field label="Domain" hint="How usage is matched back to this customer.">
							<TextInput
								required
								placeholder="acme.com"
								value={form.domain}
								onChange={(e) => setForm({ ...form, domain: e.target.value })}
							/>
						</Field>
						<Field label="Since" hint="e.g. 2024-08">
							<TextInput
								required
								placeholder="2024-08"
								value={form.since}
								onChange={(e) => setForm({ ...form, since: e.target.value })}
							/>
						</Field>
						<div className="sm:col-span-2">
							<Field
								label="Consent"
								hint="Only switch to named once they've actually agreed to be identified publicly."
							>
								<select
									value={form.consent}
									onChange={(e) =>
										setForm({ ...form, consent: e.target.value as "named" | "anonymous" })
									}
									className={selectClass}
								>
									<option value="anonymous">Anonymous (default — no consent to be named yet)</option>
									<option value="named">Named (they&rsquo;ve agreed to be identified)</option>
								</select>
							</Field>
						</div>
						<div className="sm:col-span-2">
							<Button type="submit" disabled={adding}>
								{adding ? "Adding…" : "Add customer"}
							</Button>
						</div>
					</form>
				</Card>
			) : (
				<div>
					<Button type="button" variant="secondary" onClick={() => setShowForm(true)}>
						Add a customer
					</Button>
				</div>
			)}
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
		<tr className="bg-ink/60">
			<Td>
				<TextInput
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="w-full py-1.5"
				/>
			</Td>
			<Td>
				<TextInput
					value={domain}
					onChange={(e) => setDomain(e.target.value)}
					className="w-full py-1.5"
				/>
			</Td>
			<Td>
				<TextInput
					value={since}
					onChange={(e) => setSince(e.target.value)}
					className="w-24 py-1.5"
				/>
			</Td>
			<Td>
				<select
					value={consent}
					onChange={(e) => setConsent(e.target.value as "named" | "anonymous")}
					className={`${selectClass} py-1.5`}
				>
					<option value="anonymous">Anonymous</option>
					<option value="named">Named</option>
				</select>
			</Td>
			<Td>
				<div className="flex flex-wrap gap-x-3 gap-y-1">
					{features.map((f) => (
						<label key={f} className="flex items-center gap-1.5 font-mono text-[11px] text-fog">
							<input
								type="checkbox"
								checked={selectedFeatures.includes(f)}
								onChange={() => toggleFeature(f)}
								className="accent-mint"
							/>
							{f}
						</label>
					))}
				</div>
			</Td>
			<Td className="text-right whitespace-nowrap">
				<span className="inline-flex items-center gap-3">
					<button
						type="button"
						onClick={() => onSave({ name, domain, since, consent, features: selectedFeatures })}
						className="text-xs font-medium text-mint transition hover:underline"
					>
						Save
					</button>
					<button
						type="button"
						onClick={onCancel}
						className="text-xs text-fog transition hover:text-mint"
					>
						Cancel
					</button>
				</span>
			</Td>
		</tr>
	);
}
