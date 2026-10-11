const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrderInvoicePdf, __testables } = require('../utils/orderInvoicePdf');

const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=';

const makeLegacyOrder = () => ({
  orderId: 'PDF-100',
  totalAmount: 1200,
  grandTotal: 1200,
  shippingAddress: { fullName: 'Customer', address: '1 Main Road', city: 'Dhaka', country: 'Bangladesh' },
  items: [{
    name: 'Product',
    productName: 'Variant Lipstick',
    productId: {
      _id: 'product-1',
      name: 'Variant Lipstick',
      sku: 'LIP-100',
      brand: 'BELORELLA Beauty',
      mainImage: 'https://example.invalid/base.jpg',
      variants: [{
        _id: 'variant-1',
        colorName: 'Rose Red',
        hexCode: '#B1123B',
        regionId: { _id: 'region-1', name: 'Dhaka' },
        images: [tinyPng],
        options: [{ size: '50', measureType: 'Volume', unitName: 'ml', price: 1200, discountPrice: 0 }],
      }],
    },
    variantInfo: {
      variantId: 'variant-1',
      regionId: 'region-1',
      regionName: 'Dhaka',
      color: 'Rose Red',
      size: '50',
      measureType: 'Volume',
      unitName: 'ml',
      imageUrl: tinyPng,
      sku: 'LIP-100',
    },
    variantId: 'variant-1',
    price: 1200,
    quantity: 1,
    assignedInventorySnapshots: [{ inventoryId: 'inventory-1', barcode: 'BAR-100', qrCode: 'QR-100' }],
  }],
});

test('invoice normalization recovers product and nested variant details and inventory codes', () => {
  const [item] = __testables.normalizeInvoiceItems(makeLegacyOrder());
  const details = __testables.itemText(item).join('\n');

  assert.equal(item.name, 'Variant Lipstick');
  assert.equal(item.variantImage, tinyPng);
  assert.equal(item.regionName, 'Dhaka');
  assert.equal(item.variantName, 'Rose Red / 50');
  assert.equal(item.price, 1200);
  assert.equal(item.assignedInventoryItems[0].barcode, 'BAR-100');
  assert.match(details, /Region: Dhaka/);
  assert.match(details, /Volume: 50 ml/);
  assert.match(details, /Color: Rose Red/);
  assert.match(details, /SKU: LIP-100/);
});

test('invoice PDF generation accepts a variant image snapshot and returns a PDF buffer', async () => {
  const pdf = await createOrderInvoicePdf(makeLegacyOrder(), {
    includeSignature: false,
    includeBarcode: false,
    includeQRCode: false,
  });

  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdf.includes(Buffer.from('/Subtype /Image')));
});

test('large inventory-code rows use current-page capacity without leaving a blank table page', async () => {
  const order = makeLegacyOrder();
  order.items[0].assignedInventorySnapshots = Array.from({ length: 55 }, (_, index) => ({
    inventoryId: `inventory-${index + 1}`,
    barcode: `BAR-${index + 1}`,
    qrCode: `QR-${index + 1}`,
  }));
  const pdf = await createOrderInvoicePdf(order, { includeSignature: false });
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;

  assert.equal(pageCount, 4);
});
