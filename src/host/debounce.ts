export interface Debounced<A extends unknown[]> {
	(...args: A): void;
	/** Runs a pending call now. */
	flush(): void;
	cancel(): void;
}

/** Runs `fn` with the latest arguments once calls have stopped for `ms`. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
	let timer: NodeJS.Timeout | undefined;
	let latest: A;
	const run = (...args: A) => {
		latest = args;
		clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			fn(...latest);
		}, ms);
	};
	run.flush = () => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
		fn(...latest);
	};
	run.cancel = () => {
		clearTimeout(timer);
		timer = undefined;
	};
	return run;
}
