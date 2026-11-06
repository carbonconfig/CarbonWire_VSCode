import type { ConsoleEntry } from "./types";

/** Methods the extension exposes to the console view. */
export type ConsoleHost = {
	ready(): ConsoleEntry[];
	clear(): void;
	copy(text: string): void;
	problem(message: string): void;
};

/** Methods the console view exposes to the extension. */
export type ConsoleView = {
	add(entry: ConsoleEntry): void;
	clear(): void;
};
