import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from "react";

/**
 * Shared form primitives for the vendor auth/onboarding surface, styled with
 * the same tokens as the public site and /staff (see globals.css). Every
 * vendor-facing form before this used raw inline-styled <input>/<button>
 * with no focus state and no shared shape — this exists so the next form
 * doesn't have to reinvent it.
 */

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<label className="grid gap-1.5 text-sm">
			<span className="font-medium text-fog">{label}</span>
			{children}
			{hint && <span className="text-xs text-fog/80">{hint}</span>}
		</label>
	);
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			{...props}
			className={`rounded border border-edge bg-ink px-3 py-2 text-sm text-[#e9efed] outline-none placeholder:text-fog/50 focus:border-mint ${props.className ?? ""}`}
		/>
	);
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return (
		<textarea
			{...props}
			className={`rounded border border-edge bg-ink px-3 py-2 text-sm text-[#e9efed] outline-none placeholder:text-fog/50 focus:border-mint ${props.className ?? ""}`}
		/>
	);
}

export function Button({
	variant = "primary",
	className = "",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
	const base = "rounded px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
	const styles =
		variant === "primary"
			? "bg-mint text-ink hover:bg-mint/90"
			: "border border-edge text-fog hover:border-mint hover:text-mint";
	return <button {...props} className={`${base} ${styles} ${className}`} />;
}

export function ErrorBanner({ children }: { children: React.ReactNode }) {
	return (
		<p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
			{children}
		</p>
	);
}

export function Notice({ children }: { children: React.ReactNode }) {
	return (
		<p className="rounded border border-mint/30 bg-mint/10 px-3 py-2 text-sm text-mint">{children}</p>
	);
}

export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<main className="flex min-h-screen items-center justify-center px-4">
			<div className="w-full max-w-sm rounded-lg border border-edge bg-panel p-8">
				<h1 className="text-xl font-semibold tracking-tight">{title}</h1>
				{children}
			</div>
		</main>
	);
}
