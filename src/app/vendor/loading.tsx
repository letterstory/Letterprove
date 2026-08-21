import { CardSkeleton, HeaderSkeleton } from "@/components/skeleton";

export default function Loading() {
	return (
		<>
			<HeaderSkeleton />
			<div className="mt-8 grid gap-4">
				<CardSkeleton lines={2} />
				<CardSkeleton lines={2} />
				<CardSkeleton lines={1} />
			</div>
		</>
	);
}
