"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/auth/browser";

export function SignOutButton() {
	const router = useRouter();

	return (
		<button
			type="button"
			onClick={async () => {
				await createClient().auth.signOut();
				router.replace("/vendor/login");
				router.refresh();
			}}
		>
			Sign out
		</button>
	);
}
