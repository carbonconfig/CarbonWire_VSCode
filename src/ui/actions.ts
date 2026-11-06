import { iconSvg } from "./icons";

/** Svelte action that renders an icon into the element. */
export function icon(node: HTMLElement, name: string) {
	const render = (next: string) => {
		node.innerHTML = iconSvg(next);
		node.classList.add("carbonwire-icon");
	};
	render(name);
	return { update: render };
}

/**
 * Opens VS Code's context menu for an element: the `webview/context` items matching its
 * data-vscode-context.
 */
export function openContextMenu(event: MouseEvent): void {
	event.preventDefault();
	event.stopPropagation();
	const target = event.currentTarget as HTMLElement;
	const rect = target.getBoundingClientRect();
	target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
}
