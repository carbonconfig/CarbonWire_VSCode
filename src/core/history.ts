import type { Header, HttpRequest } from "./model";
import type { Timings } from "./transport/types";

export interface HistoryResponse {
	status: number;
	statusText: string;
	headers: Header[];
	bodyBytes: number;
	/** The body was cut short, when sent or in history. */
	truncated: boolean;
	httpVersion: string;
	timings: Timings;
}

/** One send. The request is kept as written, so environment secrets never reach history. */
export interface HistoryEntry {
	id: number;
	time: number;
	name: string;
	/** The request's file when it was sent, if it was saved. */
	source?: string;
	environment?: string;
	request: HttpRequest;
	response?: HistoryResponse;
	error?: string;
}
