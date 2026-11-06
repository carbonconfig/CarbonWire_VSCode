import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/** Folder holding the webview bundles, the only files a webview may load. */
export function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(extensionUri, "dist", "webview");
}

export interface PageOptions {
	/** Allows inline styles, which the HTML preview's sandboxed frame needs. Scripts stay limited to the extension's. */
	inlineStyles?: boolean;
}

/**
 * A page that loads one webview bundle under a strict content security policy: only the extension's
 * scripts run, and nothing loads from the network.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, entry: string, options: PageOptions = {}): string {
	const root = webviewRoot(extensionUri);
	const script = webview.asWebviewUri(vscode.Uri.joinPath(root, `${entry}.js`));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(root, `${entry}.css`));
	const nonce = randomBytes(16).toString("base64");
	const csp = [
		"default-src 'none'",
		`script-src 'nonce-${nonce}' ${webview.cspSource}`,
		`style-src ${webview.cspSource}${options.inlineStyles ? " 'unsafe-inline'" : ""}`,
		`img-src ${webview.cspSource} blob: data:`,
		`font-src ${webview.cspSource}`,
		`connect-src ${webview.cspSource}`,
		"worker-src blob:",
	].join("; ");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style.toString()}">
</head>
<body>
<script type="module" nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
}
