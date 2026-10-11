const test = require('node:test');
const assert = require('node:assert/strict');
const { customerOwnsRoom } = require('../utils/chatRoomAccess');

test('customer can access their own chat room by id', () => {
  assert.equal(customerOwnsRoom({ customerId: 'customer-1' }, 'customer-1'), true);
});

test('customer can access their own populated chat room', () => {
  assert.equal(customerOwnsRoom({ customerId: { _id: 'customer-1' } }, { _id: 'customer-1' }), true);
});

test('customer cannot access another customer room or missing identifiers', () => {
  assert.equal(customerOwnsRoom({ customerId: 'customer-2' }, 'customer-1'), false);
  assert.equal(customerOwnsRoom({ customerId: 'customer-1' }, null), false);
  assert.equal(customerOwnsRoom(null, 'customer-1'), false);
});
