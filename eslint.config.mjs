import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
	...nextVitals,
	...nextTs,
	{
		rules: {
			// Stripping a field by destructuring it into a discard is the clearest
			// way to build "everything except the signature", and it is load-bearing
			// here — see signAttestation's guard against re-signing.
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{ varsIgnorePattern: "^_", argsIgnorePattern: "^_", ignoreRestSiblings: true },
			],
		},
	},
	globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
