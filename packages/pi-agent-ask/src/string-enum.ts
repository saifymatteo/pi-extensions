import { Type, type TUnsafe } from "typebox";

/**
 * `{ type: "string", enum }` (the shape Google's API needs, same output as pi-ai's StringEnum),
 * typed for typebox: pi-ai 1.6's StringEnum returns a pi-schema `Schema`, which `Type.Object`
 * statics read as `unknown`.
 */
export function StringEnum<const T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
