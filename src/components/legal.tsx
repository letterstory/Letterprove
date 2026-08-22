import type { ReactNode } from "react";
import Link from "next/link";
import { SiteHeader, SiteFooter } from "./chrome";

/**
 * Shared chrome for the public legal pages (/privacy, /terms).
 *
 * The numbered-section structure is borrowed from the sibling product
 * (lettertrace's components/legal.tsx); the chrome and tokens are this
 * project's own, so these pages read as part of Letterprove rather than as a
 * transplant. The *content* is deliberately not shared: the two products
 * collect materially different things, and a policy that describes the wrong
 * data flow is worse than none.
 *
 * Prose measure is narrower than the rest of the site (3xl, not 5xl). These
 * are read start-to-finish rather than scanned, and they get cited from
 * contracts.
 */
export function LegalPage({
	title,
	updated,
	intro,
	children,
}: {
	title: string;
	updated: string;
	intro: string;
	children: ReactNode;
}) {
	return (
		<>
			<SiteHeader />
			<main className="mx-auto max-w-3xl px-6 py-14">
				<h1 className="text-4xl font-semibold tracking-tight text-balance">{title}</h1>
				<p className="mt-3 text-sm text-fog">Last updated {updated}</p>
				<p className="mt-6 leading-relaxed text-fog">{intro}</p>

				<div className="mt-12 space-y-10">{children}</div>

				<div className="mt-16 border-t border-edge pt-8 text-sm text-fog">
					<p>
						Letterprove is operated by The Letter Company.{" "}
						<Link href="/privacy" className="text-mint hover:underline">
							Privacy Policy
						</Link>{" "}
						·{" "}
						<Link href="/terms" className="text-mint hover:underline">
							Terms of Service
						</Link>
					</p>
				</div>
			</main>
			<SiteFooter />
		</>
	);
}

export function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
	return (
		<section id={`s${n}`} className="scroll-mt-8">
			<h2 className="text-2xl font-semibold tracking-tight">
				<span className="mr-2 text-fog/70">{n}.</span>
				{title}
			</h2>
			<div className="mt-4 space-y-4 leading-relaxed text-fog [&_a]:text-mint hover:[&_a]:underline [&_code]:rounded-sm [&_code]:bg-ink [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_li]:leading-relaxed [&_strong]:font-semibold [&_strong]:text-[#e9efed] [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
				{children}
			</div>
		</section>
	);
}
