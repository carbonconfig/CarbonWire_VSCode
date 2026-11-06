import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// Run inside VS Code by `npm run test:integration` and `npm run test:perf`.
		exclude: ["tests/integration/**", "tests/perf/**"],
		environment: "node",
	},
});
