import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { DEFAULT_CONFIG } from "../src/config.ts";

const schema = JSON.parse(fs.readFileSync("schemas/orchestrator.schema.json", "utf8"));

test("schema top-level properties are exactly the default-config keys plus $schema", () => {
	assert.deepEqual(Object.keys(schema.properties).sort(), ["$schema", ...Object.keys(DEFAULT_CONFIG)].sort());
	assert.equal(schema.additionalProperties, false);
});

test("schema defaults match DEFAULT_CONFIG and every property is described", () => {
	for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
		assert.deepEqual(schema.properties[key].default, value, key);
	}
	for (const [key, property] of Object.entries<any>(schema.properties)) {
		assert.equal(typeof property.description, "string", key);
	}
});

test("schema identifies itself by its GitHub raw URL", () => {
	assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
	assert.equal(schema.$id, "https://raw.githubusercontent.com/saifymatteo/pi-extensions/main/packages/pi-orchestrator/schemas/orchestrator.schema.json");
	assert.match(schema.description, /orchestrator\.jsonc/);
	assert.match(schema.description, /orchestrator\.json\b/);
});
