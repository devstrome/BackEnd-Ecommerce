const test = require('node:test');
const assert = require('node:assert/strict');
const { __testables } = require('../controller/FinanceController');

const { parseDateRange, makeOnlineRows, makePOSRows, filterRows, groupRows, csvCell } = __testables;

test('finance date-only filters use Bangladesh calendar-day boundaries', () => {
  const { start, end } = parseDateRange({ startDate: '2026-10-09', endDate: '2026-10-09' });
  assert.equal(start.toISOString(), '2026-10-08T18:00:00.000Z');
  assert.equal(end.toISOString(), '2026-10-09T17:59:59.999Z');
});

test('online finance rows use exact assigned-unit cost snapshots and preserve variant data', () => {
  const [row] = makeOnlineRows({
    _id: 'order-1',
    orderId: 'BL-100',
    createdAt: new Date('2026-10-09T03:00:00.000Z'),
    orderStatus: 'processing',
    paymentStatus: 'paid',
    discountAmount: 0,
    items: [{
      _id: 'item-1', productId: 'product-1', name: 'Lipstick', productSlug: 'lipstick',
      price: 100, originalPrice: 120, quantity: 2, discountApplied: 0,
      variantId: 'variant-1', variantName: 'Red / XL', sku: 'LIP-RED-XL', regionName: 'Dhaka',
      assignedInventoryItems: [{ costPrice: 30, barcode: 'BC-1' }, { costPrice: 45, barcode: 'BC-2' }],
    }],
  });

  assert.equal(row.variantName, 'Red / XL');
  assert.equal(row.regionName, 'Dhaka');
  assert.equal(row.sku, 'LIP-RED-XL');
  assert.equal(row.barcode, 'BC-1, BC-2');
  assert.equal(row.costAmount, 75);
  assert.equal(row.costPrice, 37.5);
  assert.equal(row.lineRevenue, 200);
  assert.equal(row.profit, 125);
});

test('POS refunds are allocated across item rows once, not repeated per item', () => {
  const rows = makePOSRows({
    _id: 'pos-1', orderNumber: 'POS-1', createdAt: new Date('2026-10-09T03:00:00.000Z'),
    orderStatus: 'refunded', paymentStatus: 'refunded', refundAmount: 150,
    subtotal: 500, discount: 0, total: 500,
    items: [
      { _id: 'pos-item-1', productId: 'p1', productName: 'Item A', unitPrice: 100, totalPrice: 100, quantity: 1, costPrice: 40 },
      { _id: 'pos-item-2', productId: 'p2', productName: 'Item B', unitPrice: 200, totalPrice: 400, quantity: 2, costPrice: 80 },
    ],
  });

  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + row.refundAmount, 0), 150);
  assert.equal(rows[0].refundAmount, 30);
  assert.equal(rows[1].refundAmount, 120);
  assert.ok(rows.every((row) => !row.isSale));
});

test('POS partial refunds reduce the item revenue while preserving the remaining sale', () => {
  const rows = makePOSRows({
    _id: 'pos-partial', orderNumber: 'POS-PARTIAL', createdAt: new Date('2026-10-09T03:00:00.000Z'),
    orderStatus: 'completed', paymentStatus: 'partially_refunded', refundAmount: 150,
    subtotal: 500, discount: 0, total: 500,
    items: [
      { _id: 'pos-item-1', productId: 'p1', productName: 'Item A', unitPrice: 100, totalPrice: 100, quantity: 1, costPrice: 40 },
      { _id: 'pos-item-2', productId: 'p2', productName: 'Item B', unitPrice: 200, totalPrice: 400, quantity: 2, costPrice: 80 },
    ],
  });

  assert.ok(rows.every((row) => row.isSale));
  assert.equal(rows.reduce((sum, row) => sum + row.refundAmount, 0), 150);
  assert.equal(rows.reduce((sum, row) => sum + row.lineRevenue, 0), 350);
});

test('profit ranking does not invent costs for rows without cost data', () => {
  const grouped = groupRows([
    { productId: 'p1', productName: 'No cost', quantity: 2, lineRevenue: 200, grossUnitPrice: 100, catalogDiscount: 0, couponDiscount: 0, costPrice: null, costAmount: null, profit: null, isSale: true, source: 'online', sourceId: 'o1', categories: [] },
    { productId: 'p2', productName: 'Known cost', quantity: 1, lineRevenue: 100, grossUnitPrice: 100, catalogDiscount: 0, couponDiscount: 0, costPrice: 40, costAmount: 40, profit: 60, isSale: true, source: 'online', sourceId: 'o2', categories: [] },
  ], (row) => row.productId);

  assert.equal(grouped.find((row) => row.productId === 'p1').profit, null);
  assert.equal(grouped.find((row) => row.productId === 'p1').estimatedProfit, 200);
  assert.equal(grouped.find((row) => row.productId === 'p2').profit, 60);
});

test('finance filters accept populated category objects and CSV protects formula cells', () => {
  const rows = [{
    productId: 'p1', variantId: 'v1', productName: 'Lipstick', variantName: 'Red / XL', sku: 'LIP-1', barcode: '123',
    orderId: 'BL-1', customer: 'A Customer', paymentStatus: 'paid', orderStatus: 'processing', courier: '',
    categories: [{ name: 'Makeup' }], brand: 'Belorella', profit: 10,
  }];
  assert.equal(filterRows(rows, { productCategory: 'Makeup', variant: 'Red' }).length, 1);
  assert.equal(filterRows(rows, { productCategory: 'Shoes' }).length, 0);
  assert.equal(csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"');
  assert.equal(csvCell('A "quote"'), '"A ""quote"""');
});
