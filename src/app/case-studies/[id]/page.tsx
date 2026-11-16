import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/chrome";
import { loadCaseStudy } from "@/lib/attest/case-studies";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
	const study = await loadCaseStudy((await params).id);
	if (!study) return { title: "Case study — Letterprove" };
	return {
		title: `${study.headline} — ${study.vendor.name}`,
		description: study.paragraphs[0]?.slice(0, 200),
	};
}

const day = (iso: string) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});

/**
 * A case study Letter wrote from the vendor's usage data (lib/attest/case-studies.ts), at the Letterprove URL its
 * pull request links to. The words as published, the facts under them, and where the numbers came from.
 */
export default async function CaseStudyPage({ params }: Params) {
	const study = await loadCaseStudy((await params).id);
	if (!study) notFound();
	return (
		<>
			<SiteHeader />
			<main className="mx-auto max-w-3xl px-6 py-14">
				<p className="text-sm text-fog">
					{study.vendor.name}
					{study.vendor.domain ? ` · ${study.vendor.domain}` : ""}
				</p>
				<h1 className="mt-3 text-3xl font-semibold tracking-tight">{study.headline}</h1>
				<div className="mt-8 space-y-5 text-lg leading-relaxed">
					{study.paragraphs.map((p, i) => (
						<p key={i}>{p}</p>
					))}
				</div>
				{study.facts.length > 0 && (
					<section className="mt-12 border-t border-edge pt-8">
						<h2 className="text-sm font-semibold">Facts</h2>
						<ul className="mt-4 space-y-2 text-sm">
							{study.facts.map((f, i) => (
								<li key={i}>{f.text}</li>
							))}
						</ul>
					</section>
				)}
				<p className="mt-10 text-sm text-fog">
					{study.vendor.name}&apos;s usage data from {day(study.window.since)} to {day(study.window.until)}, counted by Letter on its product. Vendor-stated:
					not signed by Letterprove.
				</p>
			</main>
			<SiteFooter />
		</>
	);
}
