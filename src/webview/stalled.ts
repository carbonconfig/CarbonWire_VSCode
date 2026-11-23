/*
 * When the extension is updated or restarted, VS Code keeps pages that were already open, but nothing
 * answers them any more, so a page would stay blank. Reloading the window restores them.
 */
export function noticeIfStalled(ms = 5000): () => void {
	let notice: HTMLElement | undefined;
	const timer = window.setTimeout(() => {
		notice = document.createElement("p");
		notice.className = "carbonwire-muted carbonwire-tab-message";
		notice.textContent = "Still waiting for CarbonWire. If it was just updated or restarted, this tab can't reconnect: close it and open it again, or run Developer: Reload Window.";
		document.body.append(notice);
	}, ms);
	return () => {
		window.clearTimeout(timer);
		notice?.remove();
	};
}
