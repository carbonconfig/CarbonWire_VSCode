import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import esbuild from "esbuild";
import sveltePlugin from "esbuild-svelte";

/*
 * No argument: watch. "development": one build with source maps. "production": minified.
 * "test" and "perf": a development or production build plus the integration tests.
 */
const mode = process.argv[2] ?? "watch";
const prod = mode === "production" || mode === "perf";

// A release build starts from an empty dist/, so test builds never end up in the package.
if (prod) rmSync("dist", { recursive: true, force: true });

const common = {
	bundle: true,
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	metafile: true,
};

/*
 * Large modules needed only after activation, each built as its own file in dist/ and required
 * on first use. Keys are what the code imports.
 */
const LAZY = { yaml: "yaml", "./import-formats": "importers" };
const lazyFiles = {
	name: "lazy-files",
	setup(build) {
		const names = Object.keys(LAZY).map((k) => k.replace(/[./]/g, "\\$&"));
		build.onResolve({ filter: new RegExp(`^(${names.join("|")})$`) }, (args) =>
			args.kind === "entry-point" ? undefined : { path: `./${LAZY[args.path]}.js`, external: true },
		);
	},
};

/* Modules imported with import() that live in dist/send.js (src/host/send-bundle.ts). */
const SEND_MODULES = [
	...["sender", "transport/node", "auth/oauth2", "export/curl", "export/snippet", "export/collection", "export/zip", "cookies", "header-presets"].map((m) => `src/core/${m}.ts`),
	"src/host/exporter.ts",
].map((m) => resolvePath(m));
const sendFile = {
	name: "send-file",
	setup(build) {
		build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
			if (args.kind !== "dynamic-import") return undefined;
			return SEND_MODULES.includes(resolvePath(args.resolveDir, `${args.path}.ts`)) ? { path: "./send.js", external: true } : undefined;
		});
	},
};

// Lazy imports become plain require() calls, which VS Code's extension host loads like the rest.
const node = { format: "cjs", platform: "node", target: "node22", supported: { "dynamic-import": false } };

// Runs in VS Code's extension host, on the Node version of VS Code's Electron.
const extension = await esbuild.context({
	...common,
	...node,
	entryPoints: ["src/extension.ts"],
	outfile: "dist/extension.js",
	external: ["vscode"],
	plugins: [lazyFiles, sendFile],
});

const lazy = await esbuild.context({
	...common,
	...node,
	entryPoints: { yaml: "yaml", importers: "src/host/import-formats.ts", send: "src/host/send-bundle.ts" },
	external: ["vscode"],
	outdir: "dist",
	plugins: [lazyFiles],
});

/* pdf.js runs its parser in a worker, which the PDF viewer starts from this file. */
const copyPdfWorker = {
	name: "copy-pdf-worker",
	setup(build) {
		build.onEnd(() => {
			mkdirSync("dist/webview", { recursive: true });
			copyFileSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "dist/webview/pdf.worker.min.mjs");
		});
	},
};

/*
 * Webview pages: browser only, no Node and no `vscode` module. Shared code and code loaded on
 * first use, such as pdf.js, go into chunks.
 */
const webview = await esbuild.context({
	...common,
	entryPoints: { sidebar: "src/webview/sidebar.ts", request: "src/webview/request.ts", settings: "src/webview/settings.ts", console: "src/webview/console.ts" },
	outdir: "dist/webview",
	format: "esm",
	splitting: true,
	chunkNames: "chunks/[name]-[hash]",
	platform: "browser",
	target: "es2023",
	conditions: ["svelte", "browser"],
	loader: { ".svg": "text" },
	plugins: [sveltePlugin({ compilerOptions: { css: "external", dev: !prod } }), copyPdfWorker],
});

const contexts = [extension, lazy, webview];
if (mode === "test" || mode === "perf") {
	rmSync("dist/test", { recursive: true, force: true });
	contexts.push(
		await esbuild.context({
			...common,
			...node,
			entryPoints: ["tests/integration/*.test.ts", "tests/perf/*.test.ts"],
			outbase: "tests",
			outdir: "dist/test",
			external: ["vscode"],
		}),
	);
}
if (mode === "watch") {
	await Promise.all(contexts.map((c) => c.watch()));
} else {
	const results = await Promise.all(contexts.map((c) => c.rebuild()));
	await Promise.all(contexts.map((c) => c.dispose()));
	if (prod) writeNotices(results);
}

/* The license of every bundled package goes into dist/THIRD_PARTY_NOTICES.txt, which ships in the package. */
function writeNotices(results) {
	const roots = new Set(["node_modules/pdfjs-dist"]);
	for (const { metafile } of results) {
		for (const input of Object.keys(metafile.inputs)) {
			const m = /^(?:.*\/)?node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
			if (m) roots.add(`node_modules/${m[1]}`);
		}
	}
	const sections = [...roots].sort().map((root) => {
		const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
		const file = readdirSync(root).find((f) => /^(license|licence|copying)(\.|$)/i.test(f));
		const text = file ? readFileSync(`${root}/${file}`, "utf8").trim() : `Licensed under ${pkg.license}.`;
		return `${pkg.name} ${pkg.version} (${pkg.license})\n${"-".repeat(72)}\n${text}`;
	});
	const intro = "CarbonWire includes the following open source packages. Their licenses follow.";
	writeFileSync("dist/THIRD_PARTY_NOTICES.txt", `${intro}\n\n${sections.join("\n\n\n")}\n`);
}
