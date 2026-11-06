import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

const NODE_MODULES = ["node:*", "fs", "fs/*", "path", "http", "https", "net", "tls", "zlib", "crypto", "os", "child_process"];

export default tseslint.config(
	{ ignores: ["node_modules/", "dist/", ".vscode-test/", "**/*.mjs", "**/*.mts"] },
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	{
		files: ["src/**/*.ts", "tests/**/*.ts"],
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
	},
	// Test fakes implement async interfaces without awaiting anything.
	{
		files: ["tests/**/*.ts"],
		rules: { "@typescript-eslint/require-await": "off" },
	},
	// The core stays free of VS Code so it can be tested in plain Node.
	{
		files: ["src/core/**/*.ts"],
		rules: { "no-restricted-imports": ["error", { paths: ["vscode"] }] },
	},
	// Webview code runs in a browser sandbox, with neither VS Code's API nor Node.
	{
		files: ["src/webview/**/*.ts", "src/ui/**/*.ts"],
		rules: { "no-restricted-imports": ["error", { paths: ["vscode"], patterns: NODE_MODULES }] },
	},
);
