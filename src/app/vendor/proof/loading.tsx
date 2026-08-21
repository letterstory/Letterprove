import { CardSkeleton, HeaderSkeleton, Shimmer } from "@/components/skeleton";

export default function Loading() {
	return (
		<>
			<HeaderSkeleton />
			<div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				{Array.from({ length: 4 }).map((_, i) => (
					<div key={i} className="rounded-lg border border-edge bg-panel px-4 py-3">
						<Shimmer className="h-2.5 w-20" />
						<Shimmer className="mt-2.5 h-7 w-14" />
					</div>
				))}
			</div>
			<div className="mt-4 grid gap-4">
				<CardSkeleton lines={3} />
				<CardSkeleton lines={2} />
			</div>
		</>
	);
}
