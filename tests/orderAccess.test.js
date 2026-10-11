const test = require('node:test');
const assert = require('node:assert/strict');
const { ownsOrder, customerOrdersFilter } = require('../utils/orderAccess');

test('customer order access compares only the authenticated order owner', () => {
  assert.equal(ownsOrder({ userId: 'customer-1' }, 'customer-1'), true);
  assert.equal(ownsOrder({ userId: { _id: 'customer-1' } }, { _id: 'customer-1' }), true);
  assert.equal(ownsOrder({ userId: 'customer-2' }, 'customer-1'), false);
  assert.equal(ownsOrder({ userId: 'customer-1' }, null), false);
});

test('customer order list filters are derived from the authenticated identity', () => {
  assert.deepEqual(customerOrdersFilter({ _id: 'customer-1' }), { userId: 'customer-1' });
  assert.equal(customerOrdersFilter(null), null);
});
