import type { ReactNode } from "react";

/**
 * Layout primitives for the signed-in surface, in the same tokens as
 * `form.tsx` (ink/panel/edge/mint/fog). Kept separate from form.tsx because
 * these are about page structure rather than input, and the vendor pages were
 * each inventing their own headings, cards and empty states.
 */

export function PageHeader({
	title,
	children,
	aside,
}: {
	title: string;
	children?: ReactNode;
	aside?: ReactNode;
}) {
	return (
		<header className="flex flex-wrap items-start justify-between gap-4">
			<div className="max-w-2xl">
				<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
				{children && <div className="mt-2 text-sm leading-relaxed text-fog">{children}</div>}
			</div>
			{aside}
		</header>
	);
}

export function Card({
	title,
	children,
	aside,
	className = "",
}: {
	title?: string;
	children: ReactNode;
	aside?: ReactNode;
	className?: string;
}) {
	return (
		<section className={`rounded-lg border border-edge bg-panel p-5 ${className}`}>
			{(title || aside) && (
				<div className="flex flex-wrap items-center justify-between gap-3">
					{title && (
						<h2 className="text-xs font-semibold tracking-widest text-fog uppercase">{title}</h2>
					)}
					{aside}
				</div>
			)}
			<div className={title || aside ? "mt-4" : ""}>{children}</div>
		</section>
	);
}

/**
 * A number and what it means. Sized so a row of them reads as one object —
 * the value first, because that is what someone came to the page for.
 */
export function Stat({
	label,
	value,
	hint,
	tone = "default",
}: {
	label: string;
	value: ReactNode;
	hint?: string;
	tone?: "default" | "mint" | "muted";
}) {
	const valueTone =
		tone === "mint" ? "text-mint" : tone === "muted" ? "text-fog" : "text-[#e9efed]";
	return (
		<div className="rounded-lg border border-edge bg-panel px-4 py-3">
			<div className="text-[11px] font-medium tracking-widest text-fog uppercase">{label}</div>
			<div className={`mt-1 text-2xl font-semibold tabular-nums ${valueTone}`}>{value}</div>
			{hint && <div className="mt-0.5 text-xs text-fog">{hint}</div>}
		</div>
	);
}

export function StatRow({ children }: { children: ReactNode }) {
	return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

export function Badge({
	children,
	tone = "neutral",
	dot = true,
}: {
	children: ReactNode;
	tone?: "neutral" | "mint" | "warn";
	dot?: boolean;
}) {
	const tones = {
		neutral: "border-edge text-fog",
		mint: "border-mint/40 text-mint",
		warn: "border-amber-400/40 text-amber-300",
	} as const;
	const dots = { neutral: "bg-fog", mint: "bg-mint", warn: "bg-amber-300" } as const;
	return (
		<span
			className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap ${tones[tone]}`}
		>
			{dot && <span className={`h-1.5 w-1.5 rounded-full ${dots[tone]}`} aria-hidden="true" />}
			{children}
		</span>
	);
}

/**
 * Empty states say what will fill the space and how, rather than only that it
 * is empty — "No customers yet" alone leaves someone looking for the button.
 */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="rounded-lg border border-dashed border-edge px-6 py-10 text-center">
			<p className="text-sm font-medium text-[#e9efed]">{title}</p>
			{children && <p className="mx-auto mt-1.5 max-w-md text-sm text-fog">{children}</p>}
		</div>
	);
}

/** Horizontal scroll lives on the table, never on the page. */
export function TableWrap({ children }: { children: ReactNode }) {
	return (
		<div className="overflow-x-auto rounded-lg border border-edge bg-panel">
			<table className="w-full text-sm">{children}</table>
		</div>
	);
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
	return (
		<th
			className={`border-b border-edge bg-ink/40 px-4 py-2.5 text-left text-[11px] font-semibold tracking-widest text-fog uppercase whitespace-nowrap ${className}`}
		>
			{children}
		</th>
	);
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
	return <td className={`border-b border-edge/60 px-4 py-3 align-middle ${className}`}>{children}</td>;
}

/** A monospace value that is meant to be read or copied, not skimmed. */
export function Mono({ children }: { children: ReactNode }) {
	return <span className="font-mono text-[13px] text-[#e9efed]">{children}</span>;
}
