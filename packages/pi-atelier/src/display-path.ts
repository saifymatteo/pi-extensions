import { homedir } from "node:os";
import nodePath from "node:path";

/** Formats a filesystem path for stable, cross-platform UI display. */
export function toDisplayPath(value: string, separator: string = nodePath.sep): string {
	return value.replaceAll(separator, "/");
}

type PathApi = typeof nodePath.posix;

function pathApiFor(...values: string[]): PathApi {
	if (values.some((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value))) {
		return values.some((value) => value.startsWith("/")) ? nodePath.posix : nodePath.win32;
	}
	if (values.some((value) => value.startsWith("\\\\"))) return nodePath.win32;
	return nodePath;
}

/** Resolves a path using the path flavor represented by the inputs. */
export function resolveDisplayPath(base: string, target: string): string {
	const pathApi = pathApiFor(base, target);
	return pathApi.resolve(base, target);
}

/** Path of `target` below `base`, or undefined when it lies outside `base`. */
export function displayPathWithin(base: string, target: string): string | undefined {
	const pathApi = pathApiFor(base, target);
	const relativePath = pathApi.relative(base, target);
	if (relativePath === "") return ".";
	if (
		pathApi.isAbsolute(relativePath) ||
		relativePath === ".." ||
		relativePath.startsWith(`..${pathApi.sep}`)
	) {
		return undefined;
	}
	return toDisplayPath(relativePath, pathApi.sep);
}

/** Abbreviates the user's home directory to `~`. */
export function displayHomePath(path: string): string {
	const pathApi = pathApiFor(path);
	const home = pathApi === nodePath.posix ? (process.env.HOME ?? homedir()) : homedir();
	const withinHome = home ? displayPathWithin(pathApi.resolve(home), pathApi.resolve(path)) : undefined;
	if (withinHome === undefined) return toDisplayPath(path, pathApi.sep);
	return withinHome === "." ? "~" : `~/${withinHome}`;
}
