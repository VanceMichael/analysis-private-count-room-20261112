import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('内部人群清点按人员去重，不把访问次数当人数', () => {

  assert.equal(probe([{person: 'a', visits: 10}, {person: 'a', visits: 2}, {person: 'b', visits: 1}]).people, 2);
  assert.equal(probe([{person: 'a', visits: 0}]).people, 1);
});
