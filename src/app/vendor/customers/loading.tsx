import { HeaderSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
	return (
		<>
			<HeaderSkeleton />
			<div className="mt-8">
				<TableSkeleton rows={3} cols={5} />
			</div>
		</>
	);
}
