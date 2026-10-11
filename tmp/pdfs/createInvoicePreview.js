const fs = require('node:fs');
const { createOrderInvoicePdf } = require('../../utils/orderInvoicePdf');
const zlib = require('node:zlib');
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
};
const imageBytes = Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  pngChunk('IHDR', Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0])),
  pngChunk('IDAT', zlib.deflateSync(Buffer.from([0,177,18,59,255]))),
  pngChunk('IEND', Buffer.alloc(0)),
]);
const tinyPng = `data:image/png;base64,${imageBytes.toString('base64')}`;
(async () => {
  const order = {
    orderId: 'PDF-100', totalAmount: 1200, grandTotal: 1200,
    shippingAddress: { fullName: 'Customer', phone: '+8801700000000', address: '1 Main Road', city: 'Dhaka', postalCode: '1200', state: 'Dhaka', country: 'Bangladesh' },
    shipping: { name: 'Inside Dhaka', charge: 100, estimatedDays: 3 }, shippingCost: 100,
    items: [{ name: 'Product', productName: 'Variant Lipstick', productId: { _id: 'product-1', name: 'Variant Lipstick', sku: 'LIP-100', brand: 'BELORELLA Beauty', mainImage: 'https://example.invalid/base.jpg', variants: [{ _id: 'variant-1', colorName: 'Rose Red', hexCode: '#B1123B', regionId: { _id: 'region-1', name: 'Dhaka' }, images: [tinyPng], options: [{ size: '50', measureType: 'Volume', unitName: 'ml', price: 1200 }] }] }, variantId: 'variant-1', variantInfo: { variantId: 'variant-1', regionId: 'region-1', regionName: 'Dhaka', color: 'Rose Red', size: '50', measureType: 'Volume', unitName: 'ml', imageUrl: tinyPng, sku: 'LIP-100' }, price: 1200, quantity: 1, assignedInventorySnapshots: Array.from({ length: 55 }, (_, index) => ({ inventoryId: `inventory-${index + 1}`, barcode: `BAR-${index + 1}`, qrCode: `QR-${index + 1}` })) }],
  };
  const pdf = await createOrderInvoicePdf(order, { includeSignature: false });
  fs.writeFileSync('tmp/pdfs/invoice-multipage-review.pdf', pdf);
})();

