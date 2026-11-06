/** What pdf.js offers the PDF viewer; only the parts it uses. */
export interface PdfJs {
	getDocument(source: { data: Uint8Array; isEvalSupported?: boolean }): { promise: Promise<PdfDocument> };
}

export interface PdfDocument {
	numPages: number;
	getPage(n: number): Promise<PdfPage>;
	destroy(): Promise<void>;
}

export interface PdfViewport {
	width: number;
	height: number;
}

export interface PdfPage {
	getViewport(options: { scale: number }): PdfViewport;
	render(options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void>; cancel(): void };
}

/** Services a webview page gives its components; set once when the page starts. */
export interface UiHost {
	/** Copies through the extension, which can always reach the clipboard. */
	copy(text: string): void;
	isMac: boolean;
	loadPdfJs(): Promise<PdfJs>;
}

let current: UiHost | undefined;

export function setUiHost(host: UiHost): void {
	current = host;
}

export function uiHost(): UiHost {
	if (!current) throw new Error("The page hasn't set up its host yet.");
	return current;
}
