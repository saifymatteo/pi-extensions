import { setImmediate } from "node:timers/promises";

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** Drain already-resolved promise chains, including catch/finally, without advancing fake time. */
export const settleMicrotasks = () => setImmediate();
