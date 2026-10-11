const test = require('node:test');
const assert = require('node:assert/strict');
const escapeRegex = require('../utils/escapeRegex');

test('escapeRegex treats metacharacters as literal search text', () => {
  const input = '.*+?^${}()|[]\\';
  const escaped = escapeRegex(input);
  assert.equal(new RegExp(escaped).test(input), true);
  assert.equal(new RegExp(escaped).test('anything else'), false);
});

test('escapeRegex supports ordinary and empty strings', () => {
  assert.equal(escapeRegex('BELORELLA'), 'BELORELLA');
  assert.equal(escapeRegex(''), '');
  assert.equal(escapeRegex(null), '');
});
