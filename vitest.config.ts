import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	// postcss.config.mjs names its plugin as a string, which is Next's loader
	// convention and not Vite's — Vite would try to load it and die. Nothing
	// under test touches CSS, so give Vite an empty pipeline instead.
	css: { postcss: { plugins: [] } },
	test: {
		environment: "node",
		// scripts/ is included for verify.mjs — the artifact a sceptical third
		// party is invited to run. It lived outside the suite entirely, which
		// meant the one thing we ask outsiders to trust was the one thing
		// nothing checked.
		// .tsx as well as .ts: a component test written as .tsx would otherwise be
		// collected by nothing and silently never run, which is exactly how
		// scripts/verify.mjs went untested until 2026-08-18.
		include: ["src/**/*.test.ts?(x)", "scripts/**/*.test.ts?(x)"],
	},
});
