import test from 'node:test';
import assert from 'node:assert/strict';
import { credits, parseGoTable, parsePlanPrice, toRow, effective, compare, matches, GO_PROVIDER } from '../src/lib/model-go.ts';
test('Go multipliers apply only to Go models and unknown prices sort last', () => {
  const html = '<h2>$10/month</h2><table><tr><td>Example</td><td>$2</td><td>$3</td><td>0</td><td>0</td><td><del>$20</del><strong>$80</strong></td></tr></table>';
  const data = credits({ price: parsePlanPrice(html), limits: parseGoTable(html) });
  const go = toRow({ provider: GO_PROVIDER, id: 'example', cost: { input: 2 } }, true, data);
  const other = toRow({ provider: 'other', id: 'example', cost: { input: 2 } }, true, data);
  const unknown = toRow({ provider: 'other', id: 'unknown' }, false);
  assert.equal(go.credit, 8);
  assert.equal(go.promo, 4);
  assert.equal(other.credit, 1);
  assert.equal(effective(go), 0.25);
  assert.equal([unknown, other, go].sort((a, b) => compare('effective', a, b))[0], go);
  assert.ok(compare('input', unknown, other) > 0);
  assert.ok(matches(go, 'opencode-go EXAMPLE'));
});
