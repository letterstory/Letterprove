import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Runs ONLY *.live.test.ts — the files that hit the real shared Supabase
 * project and the real Stripe API. Deliberately separate from
 * vitest.config.ts (which excludes these) rather than a project/workspace
 * split, so `npm test` (used by ci.yml, which runs on every pull_request
 * including forks) never needs Stripe/Supabase credentials to pass.
 *
 * Invoked by `npm run test:live`, wired into .github/workflows/live-e2e.yml
 * (workflow_dispatch only, never on pull_request).
 */
export default defineConfig({
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	css: { postcss: { plugins: [] } },
	test: {
		environment: "node",
		include: ["src/**/*.live.test.ts"],
		// Real network + real Postgres round trips are slower than the mocked
		// suite; each file also gets its own throwaway vendor, so running them
		// in parallel is safe — just budget more time per test.
		testTimeout: 30_000,
	},
});
