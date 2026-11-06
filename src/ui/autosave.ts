/**
 * Sends changes to the extension once per tick. The extension keeps the latest version and
 * writes it, so nothing is lost when a tab is hidden or closed.
 */
export function createAutosave(save: () => Promise<void>) {
	let queued = false;
	let running: Promise<void> = Promise.resolve();

	function schedule(): void {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			running = save();
		});
	}

	async function flush(): Promise<void> {
		if (queued) {
			queued = false;
			running = save();
		}
		await running;
	}

	return { schedule, flush };
}
