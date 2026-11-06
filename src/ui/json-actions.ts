import type { JsonAction } from "./types";

type Runner = (action: JsonAction, path: string) => string | undefined;

let shown: Runner | undefined;

/** Called by the JSON tree on screen; returns a function that unregisters it. */
export function registerJsonTree(run: Runner): () => void {
	shown = run;
	return () => {
		if (shown === run) shown = undefined;
	};
}

/** Runs a command from a row's context menu on the tree on screen; "copyValue" returns the text. */
export function runJsonAction(action: JsonAction, path: string): string | undefined {
	return shown?.(action, path);
}
