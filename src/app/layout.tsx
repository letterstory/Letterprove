import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "Letterprove — attested proof for AI agents",
	description:
		"Cryptographically signed attestations of real product usage, published in a form an evaluating agent can fetch, verify, and cite.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<body className="font-sans antialiased">{children}</body>
		</html>
	);
}
