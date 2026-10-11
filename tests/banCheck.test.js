const test = require('node:test');
const assert = require('node:assert/strict');
const { clientIp } = require('../middleware/banCheck');

test('clientIp uses Express trusted-proxy resolution instead of the raw forwarding header', () => {
  assert.equal(clientIp({ ip: '203.0.113.10', headers: { 'x-forwarded-for': '192.0.2.99' } }), '203.0.113.10');
});

test('clientIp falls back to the socket address when Express has no resolved IP', () => {
  assert.equal(clientIp({ socket: { remoteAddress: '203.0.113.11' }, headers: {} }), '203.0.113.11');
});
