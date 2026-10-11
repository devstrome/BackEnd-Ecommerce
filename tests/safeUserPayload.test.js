const test = require('node:test');
const assert = require('node:assert/strict');
const { safeUserPayload } = require('../utils/safeUserPayload');

test('safe user responses omit passwords, tokens, and device identifiers', () => {
  const source = {
    _id: 'user-1',
    email: 'customer@example.com',
    password: 'hashed-password',
    refreshToken: 'refresh-token',
    accessTokens: [{ token: 'access-token' }],
    lastLoginIp: '192.0.2.1',
    lastDeviceId: 'device-id',
    lastFingerprint: 'fingerprint',
    lastNetwork: 'network',
  };

  const safe = safeUserPayload(source);

  assert.deepEqual(safe, { _id: 'user-1', email: 'customer@example.com' });
  assert.equal(source.password, 'hashed-password', 'sanitizing must not mutate the source object');
});

test('safe user responses accept Mongoose-like documents and null values', () => {
  const safe = safeUserPayload({
    toObject: () => ({ _id: 'user-2', fullName: 'Customer', password: 'hash', accessTokens: [] }),
  });

  assert.deepEqual(safe, { _id: 'user-2', fullName: 'Customer' });
  assert.equal(safeUserPayload(null), null);
});
