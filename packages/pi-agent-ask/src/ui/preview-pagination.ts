import { matchesKey } from "@earendil-works/pi-tui";

export interface PreviewPage {
	offset: number;
	pageSize: number;
	total: number;
}

export interface PreviewBounds {
	height: number;
	width: number;
	x: number;
	y: number;
}

export interface PreviewPagination {
	offset: number;
	onLayout(page: PreviewPage, bounds: PreviewBounds): void;
}

export type PreviewPageAction = "previous" | "next" | "first" | "last";

/** Measures rendered rows, not source lines or characters. */
export function getPreviewPage(
	total: number,
	maxRows: number | undefined,
	offset: number
): PreviewPage {
	const pageSize = Math.max(1, Math.min(total, maxRows ?? total));
	return {
		offset: Math.max(0, Math.min(offset, total - pageSize)),
		pageSize,
		total,
	};
}

export function getPreviewPageAction(
	data: string
): PreviewPageAction | undefined {
	if (matchesKey(data, "pageUp")) {
		return "previous";
	}
	if (matchesKey(data, "pageDown")) {
		return "next";
	}
	if (matchesKey(data, "home")) {
		return "first";
	}
	if (matchesKey(data, "end")) {
		return "last";
	}
	return;
}

export function movePreviewPage(
	page: PreviewPage,
	action: PreviewPageAction
): PreviewPage {
	let offset = page.offset;
	switch (action) {
		case "previous":
			offset -= page.pageSize;
			break;
		case "next":
			offset += page.pageSize;
			break;
		case "first":
			offset = 0;
			break;
		case "last":
			offset = page.total;
			break;
		default:
			break;
	}
	return getPreviewPage(page.total, page.pageSize, offset);
}
