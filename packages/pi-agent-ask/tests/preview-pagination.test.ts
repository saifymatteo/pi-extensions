import assert from "node:assert/strict";
import test from "node:test";
import {
	getPreviewPage,
	movePreviewPage,
} from "../src/ui/preview-pagination.ts";

test("preview pages clamp offsets and retain a row on short terminals", () => {
	assert.deepEqual(getPreviewPage(100, 12, 99), {
		offset: 88,
		pageSize: 12,
		total: 100,
	});
	assert.equal(getPreviewPage(100, -5, -1).pageSize, 1);
	assert.equal(getPreviewPage(100, 12, -1).offset, 0);
	assert.deepEqual(getPreviewPage(3, 12, 88), {
		offset: 0,
		pageSize: 3,
		total: 3,
	});
});

test("preview navigation advances by visible rows without overshooting", () => {
	const first = getPreviewPage(100, 12, 0);
	const next = movePreviewPage(first, "next");
	assert.equal(next.offset, 12);
	assert.deepEqual(movePreviewPage(next, "previous"), first);
	const last = movePreviewPage(first, "last");
	assert.equal(last.offset, 88);
	assert.deepEqual(movePreviewPage(last, "next"), last);
	assert.deepEqual(movePreviewPage(last, "first"), first);
	assert.deepEqual(movePreviewPage(first, "previous"), first);
});
