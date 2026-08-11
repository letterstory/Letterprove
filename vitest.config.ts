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
		include: ["src/**/*.test.ts"],
	},
});
