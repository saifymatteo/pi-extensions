import { onTestFinished } from "vitest";

/** Register ownership immediately so failed assertions cannot skip disposal. */
export function disposeAfterTest<T extends { dispose(): void }>(resource: T): T {
	onTestFinished(() => resource.dispose());
	return resource;
}
