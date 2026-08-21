"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/auth/browser";
import { Button } from "@/components/form";

export function SignOutButton() {
	const router = useRouter();

	return (
		<Button
			type="button"
			variant="secondary"
			className="!px-2.5 !py-1 text-[11px] tracking-widest uppercase"
			onClick={async () => {
				await createClient().auth.signOut();
				router.replace("/vendor/login");
				router.refresh();
			}}
		>
			Sign out
		</Button>
	);
}
