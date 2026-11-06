/**
 * Sends errors and content security policy violations to the extension's log, since the
 * webview's own console is hard to reach.
 */
export function reportProblems(report: (message: string) => void): void {
	window.addEventListener("securitypolicyviolation", (e) => report(`Blocked by the content security policy (${e.effectiveDirective}): ${e.blockedURI || e.sample || "inline"}`));
	window.addEventListener("error", (e) => report(e.error instanceof Error ? (e.error.stack ?? e.error.message) : e.message));
	window.addEventListener("unhandledrejection", (e) => report(e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)));
}

/**
 * Reports page timings for the performance tests: `painted`, as wall-clock time, and every
 * main-thread task over 50 ms as `longtask`.
 */
export function reportMetrics(report: (name: string, value: number) => void): { painted(name: string): void } {
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) report("longtask", Math.round(entry.duration));
		}).observe({ type: "longtask", buffered: true });
	} catch {
		// Long-task timing isn't available here; nothing to report.
	}
	return {
		painted: (name) => requestAnimationFrame(() => requestAnimationFrame(() => report(name, Date.now()))),
	};
}
