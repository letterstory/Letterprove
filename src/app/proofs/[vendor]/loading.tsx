import { DevKeyBanner, SiteFooter, SiteHeader } from "@/components/chrome";
import { Shimmer } from "@/components/skeleton";

/**
 * The proof page builds a signed chain per customer and reads the aggregate,
 * so there is a real second or two behind a click. Without this, Next holds
 * the previous page on screen for that whole time and the navigation reads as
 * ignored — the same reason every /vendor route already has one.
 *
 * Chrome is rendered for real rather than shimmered: the header and footer
 * need no data, so faking them would replace something correct with something
 * grey. Only the parts that are genuinely waiting get a placeholder, and they
 * are laid out to match the real content so the swap fills in rather than
 * re-flows.
 */
export default function Loading() {
	return (
		<>
			<DevKeyBanner />
			<SiteHeader />
			<main className="mx-auto max-w-5xl px-6 py-14">
				<Shimmer className="h-4 w-56" />
				<Shimmer className="mt-4 h-10 w-72" />
				<Shimmer className="mt-3 h-4 w-64" />

				{/* Four tiles, matching the real grid's columns and height. */}
				<div className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-4">
					{Array.from({ length: 4 }).map((_, i) => (
						<div key={i} className="bg-panel px-4 py-5">
							<Shimmer className="h-3 w-24" />
							<Shimmer className="mt-2.5 h-6 w-16" />
						</div>
					))}
				</div>

				<Shimmer className="mt-10 h-3 w-36" />
				<div className="mt-4 grid gap-4 sm:grid-cols-2">
					{Array.from({ length: 2 }).map((_, i) => (
						<div key={i} className="rounded-lg border border-edge bg-panel p-5">
							<div className="flex items-center justify-between gap-3">
								<Shimmer className="h-5 w-32" />
								<Shimmer className="h-5 w-28 rounded-full" />
							</div>
							<Shimmer className="mt-3 h-3.5 w-40" />
							<div className="mt-5 grid grid-cols-2 gap-4">
								<Shimmer className="h-8 w-20" />
								<Shimmer className="h-8 w-20" />
							</div>
							<Shimmer className="mt-5 h-3 w-full" />
						</div>
					))}
				</div>
			</main>
			<SiteFooter />
		</>
	);
}
