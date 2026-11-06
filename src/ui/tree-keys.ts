const ROW = '[role="treeitem"], [role="option"], .carbonwire-history-row';

/**
 * Arrow-key navigation as in VS Code's trees: Up and Down move between rows, Home and End jump
 * to the ends, Right expands or enters a folder, Left collapses it or goes to its parent.
 */
export function onTreeKeys(event: KeyboardEvent): void {
	const container = event.currentTarget as HTMLElement;
	const row = (event.target as HTMLElement).closest<HTMLElement>(ROW);
	if (!row || !container.contains(row) || event.altKey || event.ctrlKey || event.metaKey) return;
	const rows = Array.from(container.querySelectorAll<HTMLElement>(ROW));
	const i = rows.indexOf(row);
	const expanded = row.getAttribute("aria-expanded");
	let next: HTMLElement | undefined;
	switch (event.key) {
		case "ArrowDown":
			next = rows[i + 1];
			break;
		case "ArrowUp":
			next = rows[i - 1];
			break;
		case "Home":
			next = rows[0];
			break;
		case "End":
			next = rows.at(-1);
			break;
		case "ArrowRight":
			if (expanded === "false") row.click();
			else if (expanded === "true") next = rows[i + 1];
			break;
		case "ArrowLeft":
			if (expanded === "true") row.click();
			else next = row.parentElement?.closest(".tree-item-children")?.parentElement?.querySelector<HTMLElement>(":scope > [role='treeitem']") ?? undefined;
			break;
		default:
			return;
	}
	event.preventDefault();
	next?.focus();
}
