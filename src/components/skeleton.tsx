/**
 * Loading placeholders.
 *
 * Every /vendor page is force-dynamic and queries the database, so a tab click
 * has a real round-trip behind it. Without a loading.tsx Next holds the old
 * page on screen for that whole time and the click reads as ignored. These
 * shapes mirror the real content closely enough that the swap is a fill-in
 * rather than a re-layout.
 */
export function Shimmer({ className = "" }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={`block rounded bg-edge/70 motion-safe:animate-pulse ${className}`}
		/>
	);
}

export function CardSkeleton({ lines = 2 }: { lines?: number }) {
	return (
		<div className="rounded-lg border border-edge bg-panel p-5">
			<Shimmer className="h-3 w-28" />
			<div className="mt-4 grid gap-2.5">
				{Array.from({ length: lines }).map((_, i) => (
					<Shimmer key={i} className={`h-3.5 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />
				))}
			</div>
		</div>
	);
}

export function HeaderSkeleton() {
	return (
		<div className="flex flex-wrap items-start justify-between gap-4">
			<div className="w-full max-w-md">
				<Shimmer className="h-7 w-52" />
				<Shimmer className="mt-3 h-3.5 w-full" />
				<Shimmer className="mt-2 h-3.5 w-3/4" />
			</div>
			<Shimmer className="h-6 w-40 rounded-full" />
		</div>
	);
}

export function TableSkeleton({ rows = 3, cols = 5 }: { rows?: number; cols?: number }) {
	return (
		<div className="overflow-hidden rounded-lg border border-edge bg-panel">
			<div className="flex gap-4 border-b border-edge bg-ink/40 px-4 py-3">
				{Array.from({ length: cols }).map((_, i) => (
					<Shimmer key={i} className="h-2.5 flex-1" />
				))}
			</div>
			{Array.from({ length: rows }).map((_, r) => (
				<div key={r} className="flex gap-4 border-b border-edge/60 px-4 py-4 last:border-b-0">
					{Array.from({ length: cols }).map((_, c) => (
						<Shimmer key={c} className="h-3.5 flex-1" />
					))}
				</div>
			))}
		</div>
	);
}
