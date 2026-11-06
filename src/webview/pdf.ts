import type { PdfJs } from "../ui/host";

let loading: Promise<PdfJs> | undefined;

/**
 * pdf.js loads the first time a PDF is shown. Webviews can't start workers from resource URLs, so
 * the worker starts from a Blob URL.
 */
export function loadPdfJs(): Promise<PdfJs> {
	loading ??= (async () => {
		const pdfjs = await import("pdfjs-dist");
		const source = await (await fetch(new URL("pdf.worker.min.mjs", import.meta.url))).text();
		const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
		pdfjs.GlobalWorkerOptions.workerPort = new Worker(url, { type: "module" });
		return pdfjs as unknown as PdfJs;
	})();
	return loading;
}
