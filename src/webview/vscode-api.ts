interface WebviewApi<State> {
	postMessage(message: unknown): void;
	getState(): State | undefined;
	setState(state: State): void;
}

declare function acquireVsCodeApi<State>(): WebviewApi<State>;

let api: WebviewApi<unknown> | undefined;

/** VS Code's webview API, which may only be acquired once per page. */
export function vscodeApi<State>(): WebviewApi<State> {
	api ??= acquireVsCodeApi();
	return api as WebviewApi<State>;
}
