const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const axios = require('axios');
const { publicSiteUrl } = require('./brand');
const fs = require('fs');
const path = require('path');
const { formatMeasureText } = require('./measure');
let sharp;
try { sharp = require('sharp'); } catch { sharp = null; }

const BRAND = 'BELORELLA';
const TAGLINE = 'PREMIUM FASHION & LIFESTYLE';
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 36;
const CONTENT_TOP = 91;
const CONTENT_BOTTOM = PAGE_HEIGHT - 54;
const TABLE_HEAD_HEIGHT = 23;
const CODE_LINE_HEIGHT = 32;
const COLORS = { ink: '#1B1B1B', gray: '#666666', light: '#F7F5F4', line: '#D7D7D7', red: '#B1123B', darkRed: '#8F0E2F' };

const loadBrandAsset = (name) => {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'assets', name));
  } catch {
    return null;
  }
};
// Use the optimized transparent master logo for crisp PDF headers without a square backdrop.
const BRAND_LOGO = loadBrandAsset('pdf-logo.png') || loadBrandAsset('logo.png');
const BRAND_SIGNATURE = loadBrandAsset('pdf-signature.png') || loadBrandAsset('sign.png');
const BRAND_SEAL = loadBrandAsset('pdf-seal.png') || loadBrandAsset('seal.png');
const IMAGE_BUFFER_CACHE = new Map();
const IMAGE_REQUESTS = new Map();
const CODE_BUFFER_CACHE = new Map();
const CODE_REQUESTS = new Map();
const MAX_IMAGE_CACHE_BYTES = 20 * 1024 * 1024;
const MAX_CACHED_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CODE_CACHE_BYTES = 8 * 1024 * 1024;
const imageCache = { bytes: 0 };
const codeCache = { bytes: 0 };

const setBoundedBuffer = (cache, key, buffer, maxBytes, maxEntryBytes, cacheState) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > maxEntryBytes) return;
  if (cache.has(key)) {
    const previous = cache.get(key);
    cacheState.bytes -= previous.length;
    cache.delete(key);
  }
  while (cache.size && cacheState.bytes + buffer.length > maxBytes) {
    const oldestKey = cache.keys().next().value;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    cacheState.bytes -= oldest.length;
  }
  cache.set(key, buffer);
  cacheState.bytes += buffer.length;
};

const readCachedBuffer = (cache, key) => {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
};

const currency = (amount) => `BDT ${(Number(amount) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const safeString = (value) => (value == null ? '' : String(value));
const inventoryId = (value) => safeString(value?._id || value?.id || value);
const imageSource = (value) => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return value.secure_url || value.url || value.src || value.path || '';
};
const pdfCompatibleImageUrl = (value) => {
  try {
    const parsed = new URL(value);
    if (parsed.hostname === 'res.cloudinary.com' && /\/image\/upload\//i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname
        .replace(/\/image\/upload\//i, '/image/upload/f_png,c_limit,w_600,h_600/')
        .replace(/\.(?:webp|avif|jpe?g|gif)$/i, '.png');
    }
    return parsed.toString();
  } catch {
    return value;
  }
};
const columns = [
  { label: 'PRODUCT', width: 148, align: 'left' },
  { label: 'DETAILS', width: 105, align: 'left' },
  { label: 'PRICE', width: 62, align: 'right' },
  { label: 'QTY', width: 30, align: 'center' },
  { label: 'TOTAL', width: 68, align: 'right' },
  { label: 'BARCODE / QR', width: 110, align: 'left' },
];

const getImageBuffer = async (source) => {
  if (!source) return null;
  try {
    if (String(source).startsWith('data:image/')) {
      const dataUri = String(source);
      if (!/^data:image\/(?:png|jpe?g|webp);base64,/i.test(dataUri) || dataUri.length > 3 * 1024 * 1024) return null;
      if (/^data:image\/webp/i.test(dataUri) && !sharp) return null;
      let buffer = Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64');
      if (sharp) {
        try { buffer = await sharp(buffer).png().toBuffer(); } catch { return null; }
      }
      return buffer.length <= MAX_CACHED_IMAGE_BYTES ? buffer : null;
    }
    const baseUrl = publicSiteUrl();
    const requestedUrl = /^https?:\/\//i.test(String(source)) ? String(source) : `${baseUrl}${String(source).startsWith('/') ? '' : '/'}${source}`;
    const url = pdfCompatibleImageUrl(requestedUrl);
    if (!/^https?:\/\//i.test(url)) return null;
    const parsedUrl = new URL(url);
    const configuredOrigin = (() => {
      try { return new URL(baseUrl); } catch { return null; }
    })();
    const cloudinaryOrigin = parsedUrl.hostname.toLowerCase() === 'res.cloudinary.com'
      && parsedUrl.protocol === 'https:'
      && (!parsedUrl.port || parsedUrl.port === '443');
    const configuredOriginMatch = configuredOrigin
      && parsedUrl.hostname.toLowerCase() === configuredOrigin.hostname.toLowerCase()
      && parsedUrl.port === configuredOrigin.port
      && parsedUrl.protocol === configuredOrigin.protocol;
    if (!cloudinaryOrigin && !configuredOriginMatch) return null;
    const cached = readCachedBuffer(IMAGE_BUFFER_CACHE, url);
    if (cached) return cached;
    if (IMAGE_REQUESTS.has(url)) return IMAGE_REQUESTS.get(url);
    const request = axios.get(url, { responseType: 'arraybuffer', timeout: 3000, maxRedirects: 0, maxContentLength: 4 * 1024 * 1024 })
      .then(async ({ data, headers }) => {
        let buffer = Buffer.from(data);
        if (!buffer.length) return null;
        const contentType = String(headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!/^image\/(?:png|jpe?g|webp|avif)$/.test(contentType)) return null;
        if (!sharp && !/^image\/(?:png|jpe?g)$/.test(contentType)) return null;
        if (sharp && buffer.length) {
          try { buffer = await sharp(buffer).png().toBuffer(); } catch {}
        }
        if (buffer.length > MAX_CACHED_IMAGE_BYTES) return null;
        setBoundedBuffer(IMAGE_BUFFER_CACHE, url, buffer, MAX_IMAGE_CACHE_BYTES, MAX_CACHED_IMAGE_BYTES, imageCache);
        return buffer;
      })
      .catch(() => null)
      .finally(() => IMAGE_REQUESTS.delete(url));
    IMAGE_REQUESTS.set(url, request);
    return request;
  } catch {
    return null;
  }
};

const getCodeBuffer = async (kind, text) => {
  const key = `${kind}:${text}`;
  const cache = CODE_BUFFER_CACHE;
  const cached = readCachedBuffer(cache, key);
  if (cached) return cached;
  if (CODE_REQUESTS.has(key)) return CODE_REQUESTS.get(key);
  const request = (kind === 'barcode'
    ? bwipjs.toBuffer({ bcid: 'code128', text, scale: 2, height: 10, includetext: false, paddingwidth: 2, paddingheight: 2 })
    : QRCode.toBuffer(text, { type: 'png', width: 112, margin: 2, errorCorrectionLevel: 'M' }))
    .then((buffer) => {
      setBoundedBuffer(cache, key, buffer, MAX_CODE_CACHE_BYTES, MAX_CODE_CACHE_BYTES, codeCache);
      return buffer;
    })
    .catch(() => null)
    .finally(() => CODE_REQUESTS.delete(key));
  CODE_REQUESTS.set(key, request);
  return request;
};

const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();

const normalizeInvoiceItems = (order) => {
  const rawItems = Array.isArray(order.items) ? order.items : [];
  const rows = rawItems.map((rawItem) => {
    const item = typeof rawItem.toObject === 'function' ? rawItem.toObject() : { ...rawItem };
    const product = item.productId && typeof item.productId === 'object' && item.productId.name
      ? item.productId
      : (item.inventoryId?.productId?.name ? item.inventoryId.productId : null);
    const configuration = item.configuration || item.variantInfo || {};
    const variantId = item.variantId || item.variantInfo?.variantId || item.inventoryId?.variantId?._id || item.inventoryId?.variantId;
    const wantedRegion = item.regionId?._id || item.regionId || configuration.regionId?._id || configuration.regionId;
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    const variant = variants.find((entry) => String(entry._id) === String(variantId))
      || variants.find((entry) => {
        const region = entry.regionId?._id || entry.regionId;
        const sameRegion = !wantedRegion || !region || String(region) === String(wantedRegion);
        const wantedColor = item.color || configuration.color;
        return sameRegion && wantedColor && same(entry.colorName, wantedColor);
      })
      || null;
    const variantSizes = variant?.sizes || [];
    const savedSize = item.size || configuration.size || item.inventoryId?.size || '';
    const savedPrice = Number(item.price ?? item.discountPrice ?? item.unitPrice);
    const priceSizeIndex = variantSizes.findIndex((size, index) =>
      Number(variant?.prices?.[index]) === savedPrice || Number(variant?.discountPrices?.[index]) === savedPrice
    );
    const size = savedSize || (variantSizes.length === 1 ? variantSizes[0] : priceSizeIndex >= 0 ? variantSizes[priceSizeIndex] : '');
    const measureType = item.measureType || configuration.measureType || variant?.measureType || product?.measureType || '';
    const unitName = item.unitName || configuration.unitName || variant?.unitName || product?.unitName || '';
    const option = variant?.options?.find((entry) =>
      same(entry.size, size) &&
      (!measureType || !entry.measureType || same(entry.measureType, measureType)) &&
      (!unitName || !entry.unitName || same(entry.unitName, unitName))
    );
    const sizeIndex = variantSizes.findIndex((entry) => same(entry, size));
    const catalogPrice = Number(option?.discountPrice || option?.price) ||
      Number(variant?.discountPrices?.[sizeIndex] || variant?.prices?.[sizeIndex]) ||
      Number(product?.discountPrice || product?.mainPrice) || 0;
    const assignedSnapshots = Array.isArray(item.assignedInventorySnapshots) ? item.assignedInventorySnapshots : [];
    const assignedInventoryItems = Array.isArray(item.assignedInventoryItems) ? item.assignedInventoryItems : [];
    const snapshotById = new Map(assignedSnapshots.map((snapshot) => [String(snapshot.inventoryId || ''), snapshot]));
    const normalizedAssignedItems = assignedInventoryItems.length
      ? assignedInventoryItems.map((assignedItem) => {
        const snapshot = snapshotById.get(String(inventoryId(assignedItem)));
        return {
          ...assignedItem,
          barcode: assignedItem?.barcode || snapshot?.barcode || '',
          realBarcode: assignedItem?.realBarcode || snapshot?.realBarcode || '',
          qrCode: assignedItem?.qrCode || snapshot?.qrCode || '',
          imageUri: assignedItem?.imageUri || snapshot?.imageUri || '',
          size: assignedItem?.size || snapshot?.size || '',
          color: assignedItem?.color?.name || assignedItem?.color || snapshot?.color || '',
          regionName: assignedItem?.regionName || snapshot?.regionName || '',
        };
      })
      : assignedSnapshots.map((snapshot) => ({
        _id: snapshot.inventoryId,
        id: snapshot.inventoryId,
        barcode: snapshot.barcode || '',
        realBarcode: snapshot.realBarcode || '',
        qrCode: snapshot.qrCode || '',
        imageUri: snapshot.imageUri || '',
        size: snapshot.size || '',
        color: snapshot.color || '',
        regionName: snapshot.regionName || '',
      }));
    const variantImage = imageSource(item.variantImage)
      || imageSource(configuration.imageUrl)
      || imageSource(item.mainImage)
      || imageSource(item.image)
      || imageSource(variant?.images?.[0])
      || imageSource(item.inventoryId?.imageUri)
      || imageSource(normalizedAssignedItems.find((entry) => entry?.imageUri)?.imageUri)
      || imageSource(product?.mainImage);
    const region = item.regionName || configuration.regionName || item.regionId?.name
      || variant?.regionId?.name || item.inventoryId?.regionName || '';
    const color = item.color || configuration.color || item.inventoryId?.color?.name || variant?.colorName || '';
    const variantName = item.variantName || configuration.variantName || item.variantInfo?.variantName
      || [color, size].filter(Boolean).join(' / ');
    const itemName = item.name && !/^product$/i.test(String(item.name).trim())
      ? item.name
      : (item.productName || product?.name || `Product ${inventoryId(item.productId)}`);
    return {
      ...item,
      name: itemName,
      productId: product || item.productId,
      sku: item.sku || configuration.sku || item.variantInfo?.sku || product?.sku || '',
      barcode: normalizedAssignedItems.find((entry) => entry?.barcode)?.barcode || '',
      productBarcode: normalizedAssignedItems.find((entry) => entry?.realBarcode)?.realBarcode || '',
      variantName,
      variantImage,
      mainImage: variantImage,
      assignedInventoryItems: normalizedAssignedItems,
      regionName: region,
      size,
      color,
      measureType,
      unitName,
      quantity: Math.max(1, Number(item.quantity) || 1),
      price: Number.isFinite(savedPrice) && savedPrice > 0 ? savedPrice : catalogPrice,
      _savedInvoicePrice: Number.isFinite(savedPrice) && savedPrice > 0,
      _catalogFallbackPrice: catalogPrice,
    };
  });

  // Legacy orders can have valid order totals while one or more line snapshots
  // contain a zero price. Treat totalAmount as the source of truth for those
  // missing line prices and distribute the remaining subtotal by catalog value.
  const missing = rows.filter((item) => !item._savedInvoicePrice);
  const savedSubtotal = rows.filter((item) => item._savedInvoicePrice)
    .reduce((sum, item) => sum + item.price * item.quantity, 0);
  const orderSubtotal = Number(order.totalAmount);
  const remainder = orderSubtotal - savedSubtotal;
  if (missing.length && Number.isFinite(orderSubtotal) && remainder > 0) {
    const totalWeight = missing.reduce((sum, item) => sum + (item._catalogFallbackPrice * item.quantity || item.quantity), 0);
    missing.forEach((item) => {
      const weight = item._catalogFallbackPrice * item.quantity || item.quantity;
      const rowAmount = remainder * (weight / totalWeight);
      item.price = rowAmount / item.quantity;
    });
  }

  return rows.map(({ _savedInvoicePrice, _catalogFallbackPrice, ...item }) => item);
};

const prepareInventoryCodes = async (items, options) => Promise.all(items.map(async (item) => {
  const assigned = Array.isArray(item.assignedInventoryItems) ? item.assignedInventoryItems : [];
  // Only print codes captured from the actual assigned inventory unit. A SKU,
  // product id, or generated placeholder is not a scannable unit code.
  const codeEntries = assigned;
  const codes = await Promise.all(codeEntries.map(async (entry) => {
    const barcode = safeString(entry?.barcode || '');
    const qrText = safeString(entry?.qrCode || '');
    const [barcodeBuffer, qrBuffer] = await Promise.all([
      options.includeBarcode && barcode ? getCodeBuffer('barcode', barcode) : null,
      options.includeQRCode && qrText ? getCodeBuffer('qr', qrText) : null,
    ]);
    return { barcode, barcodeBuffer, qrBuffer };
  }));
  return {
    ...item,
    imageBuffer: await getImageBuffer(item.mainImage),
    preparedCodes: codes,
  };
}));

const drawPageHeader = (doc, order, options) => {
  const right = PAGE_WIDTH - MARGIN;
  doc.save();
  if (BRAND_LOGO) {
    try {
      doc.image(BRAND_LOGO, MARGIN, 27, { fit: [36, 36] });
    } catch {
      doc.rect(MARGIN, 28, 32, 32).fill(COLORS.red);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(19).text('B', MARGIN + 9, 34, { width: 15, align: 'center' });
    }
  } else if (options.showLogo) {
    doc.rect(MARGIN, 28, 32, 32).fill(COLORS.red);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(19).text('B', MARGIN + 9, 34, { width: 15, align: 'center' });
  }
  const brandX = BRAND_LOGO || options.showLogo ? MARGIN + 44 : MARGIN;
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(18).text(BRAND, brandX, 29, { characterSpacing: 2.2 });
  doc.fillColor(COLORS.gray).font('Helvetica').fontSize(7).text(TAGLINE, brandX + 1, 52);
  doc.fillColor(COLORS.darkRed).font('Helvetica-Bold').fontSize(12).text('ORDER INVOICE', right - 190, 31, { width: 190, align: 'right' });
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(`#${safeString(order.orderId)}`, right - 190, 48, { width: 190, align: 'right' });
  doc.strokeColor(COLORS.red).lineWidth(1.5).moveTo(MARGIN, 73).lineTo(right, 73).stroke();
  doc.restore();
  doc.y = CONTENT_TOP;
};

const drawInfoCard = (doc, x, y, width, title, lines, height) => {
  doc.save();
  doc.roundedRect(x, y, width, height, 3).fillAndStroke('#FFFFFF', COLORS.line);
  doc.fillColor(COLORS.red).font('Helvetica-Bold').fontSize(8).text(title.toUpperCase(), x + 9, y + 8, { width: width - 18 });
  doc.strokeColor(COLORS.line).lineWidth(0.5).moveTo(x + 8, y + 22).lineTo(x + width - 8, y + 22).stroke();
  let lineY = y + 29;
  for (const [label, value] of lines) {
    if (!value) continue;
    const content = `${label}: ${value}`;
    const textHeight = Math.max(10, wrappedHeight(doc, content, width - 18, 'Helvetica', 7.2));
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.2).text(content, x + 9, lineY, { width: width - 18, height: textHeight });
    lineY += textHeight + 2;
  }
  doc.restore();
};

const drawOrderInformation = (doc, order) => {
  const x = MARGIN;
  const y = doc.y;
  const gap = 8;
  const width = (PAGE_WIDTH - 2 * MARGIN - gap * 2) / 3;
  const address = order.shippingAddress || {};
  const shipping = order.shipping || {};
  const paymentStatus = safeString(order.paymentStatus).replace(/^./, (c) => c.toUpperCase()) || 'Pending';
  const status = safeString(order.orderStatus).replace(/^./, (c) => c.toUpperCase()) || 'Pending';
  const date = order.createdAt ? new Date(order.createdAt).toLocaleString('en-BD', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const cards = [
    { title: 'Order Information', lines: [['Order ID', `#${order.orderId}`], ['Order Date', date], ['Order Status', status], ['Payment Status', paymentStatus], ['Payment Method', order.paymentMethod || '—']] },
    { title: 'Customer Information', lines: [['Name', address.fullName], ['Phone', address.phone], ['Address', address.address], ['City', address.city], ['State / Postcode', [address.state, address.postalCode].filter(Boolean).join(' ')]] },
    { title: 'Shipping Information', lines: [['Method', shipping.name || 'Standard Shipping'], ['Shipping Cost', currency(order.shippingCost ?? shipping.charge)], ['Estimated Delivery', shipping.estimatedDays ? `${shipping.estimatedDays} days` : '—'], ['Country', address.country]] },
  ];
  const cardHeight = Math.max(112, ...cards.map(({ lines }) => 37 + lines.filter(([, value]) => value).reduce((sum, [label, value]) =>
    sum + Math.max(10, wrappedHeight(doc, `${label}: ${value}`, width - 18, 'Helvetica', 7.2)) + 2, 0)));
  cards.forEach((card, index) => drawInfoCard(doc, x + (width + gap) * index, y, width, card.title, card.lines, cardHeight));
  doc.y = y + cardHeight + 10;
};

const tableColumnX = () => {
  let x = MARGIN;
  return columns.map((column) => {
    const current = { ...column, x };
    x += column.width;
    return current;
  });
};

const drawTableHeader = (doc) => {
  const y = doc.y;
  doc.save();
  doc.rect(MARGIN, y, PAGE_WIDTH - 2 * MARGIN, TABLE_HEAD_HEIGHT).fill(COLORS.ink);
  tableColumnX().forEach((column) => {
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(6.7).text(column.label, column.x + 5, y + 8, {
      width: column.width - 10,
      align: column.align,
      lineBreak: false,
    });
  });
  doc.restore();
  doc.y = y + TABLE_HEAD_HEIGHT;
};

const addItemsPage = (doc, order, options) => {
  doc.addPage();
  drawPageHeader(doc, order, options);
  drawTableHeader(doc);
};

const wrappedHeight = (doc, text, width, font, size) => {
  doc.font(font).fontSize(size);
  return doc.heightOfString(safeString(text), { width: Math.max(12, width), lineGap: 1 });
};

const itemText = (item) => {
  const configuration = item.configuration || {};
  const size = item.size || configuration.size || '';
  const measureText = formatMeasureText(item);
  const preOrderDate = item.preOrderEstimatedDate ? new Date(item.preOrderEstimatedDate) : null;
  const preOrderLabel = item.isPreOrder
    ? `Pre-order${preOrderDate && !Number.isNaN(preOrderDate.getTime()) ? ` · Estimated ${preOrderDate.toLocaleDateString('en-BD')}` : ' · ETA to be confirmed'}`
    : '';
  const details = [
    item.regionName || configuration.regionName || item.regionId?.name ? `Region: ${item.regionName || configuration.regionName || item.regionId?.name || ''}` : '',
    preOrderLabel,
    measureText,
    item.color || configuration.color ? `Color: ${item.color || configuration.color}` : '',
    item.variantName && !same(item.variantName, [item.color, size].filter(Boolean).join(' / ')) ? `Variant: ${item.variantName}` : '',
    item.brand ? `Brand: ${item.brand}` : '',
    item.sku ? `SKU: ${item.sku}` : '',
    item.barcode ? `Barcode: ${item.barcode}` : '',
    item.productBarcode ? `Product barcode: ${item.productBarcode}` : '',
  ].filter(Boolean);
  return details;
};

const drawItemSegment = (doc, item, segmentCodes, firstSegment, rowHeight, options) => {
  const y = doc.y;
  const cell = tableColumnX();
  let currentX = MARGIN;
  cell.forEach((column) => {
    doc.rect(currentX, y, column.width, rowHeight).strokeColor(COLORS.line).lineWidth(0.45).stroke();
    currentX += column.width;
  });

  const imageX = cell[0].x + 5;
  const imageSize = 40;
  const imageY = y + Math.max(5, (rowHeight - imageSize) / 2);
  if (firstSegment && item.imageBuffer) {
    try { doc.image(item.imageBuffer, imageX, imageY, { fit: [imageSize, imageSize], align: 'center', valign: 'center' }); } catch {}
  } else if (firstSegment) {
    doc.roundedRect(imageX, imageY, imageSize, imageSize, 3).fillAndStroke(COLORS.light, COLORS.line);
    doc.fillColor(COLORS.red).font('Helvetica-Bold').fontSize(12).text(BRAND[0], imageX, imageY + 13, { width: imageSize, align: 'center' });
  }

  const textX = cell[0].x + 51;
  const textWidth = cell[0].width - 56;
  const name = firstSegment ? item.name || 'Product' : `${item.name || 'Product'} (continued)`;
  const nameHeight = Math.min(rowHeight - 8, wrappedHeight(doc, name, textWidth, 'Helvetica-Bold', 8));
  const nameY = y + Math.max(4, (rowHeight - nameHeight) / 2);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text(name, textX, nameY, { width: textWidth, height: rowHeight - 8 });

  if (firstSegment) {
    const details = itemText(item);
    let detailsY = y + 7;
    details.forEach((detail) => {
      const textHeight = Math.max(8, wrappedHeight(doc, detail, cell[1].width - 10, 'Helvetica', 7));
      doc.fillColor(COLORS.gray).font('Helvetica').fontSize(7).text(detail, cell[1].x + 5, detailsY, { width: cell[1].width - 10, height: textHeight });
      detailsY += textHeight + 2;
    });
    const values = [currency(item.price), safeString(item.quantity), currency((Number(item.price) || 0) * (Number(item.quantity) || 0))];
    [2, 3, 4].forEach((index, offset) => {
      const column = cell[index];
      doc.fillColor(COLORS.ink).font(index === 4 ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.6).text(values[offset], column.x + 3, y + 15, { width: column.width - 6, align: column.align, lineBreak: false });
    });
  }

  let codeY = y + 4;
  const codesToDraw = segmentCodes.length ? segmentCodes : (firstSegment ? [{ barcode: '', barcodeBuffer: null, qrBuffer: null }] : []);
  codesToDraw.forEach((code) => {
    const qrSize = 27;
    if (options.includeQRCode && code.qrBuffer) {
      try { doc.image(code.qrBuffer, cell[5].x + 5, codeY + 1, { width: qrSize, height: qrSize }); } catch {}
    } else if (options.includeQRCode) {
      doc.roundedRect(cell[5].x + 5, codeY + 1, qrSize, qrSize, 1).strokeColor(COLORS.line).lineWidth(0.5).stroke();
    }
    if (options.includeBarcode && code.barcodeBuffer) {
      try { doc.image(code.barcodeBuffer, cell[5].x + 35, codeY + 2, { fit: [cell[5].width - 41, 19], align: 'left', valign: 'center' }); } catch {}
    } else if (options.includeBarcode) {
      doc.roundedRect(cell[5].x + 35, codeY + 2, cell[5].width - 41, 19, 1).strokeColor(COLORS.line).lineWidth(0.5).stroke();
    }
    if (options.includeBarcode && code.barcode) {
      doc.fillColor(COLORS.gray).font('Helvetica').fontSize(5.2).text(code.barcode, cell[5].x + 35, codeY + 22, { width: cell[5].width - 40, lineBreak: false, ellipsis: true });
    }
    codeY += CODE_LINE_HEIGHT;
  });
  doc.y = y + rowHeight;
};

const drawItems = (doc, order, items, options) => {
  drawTableHeader(doc);
  for (const item of items) {
    const details = itemText(item);
    const productHeight = Math.max(35, wrappedHeight(doc, item.name || 'Product', columns[0].width - 51, 'Helvetica-Bold', 8));
    const detailsHeight = details.reduce((sum, value) => sum + wrappedHeight(doc, value, columns[1].width - 10, 'Helvetica', 7) + 2, 0);
    const maxRowHeight = CONTENT_BOTTOM - CONTENT_TOP - TABLE_HEAD_HEIGHT - 8;
    const baseHeight = Math.min(maxRowHeight, Math.max(48, productHeight + 12, detailsHeight + 12));
    const codes = options.includeQRCode || options.includeBarcode ? item.preparedCodes : [];
    if (!codes.length) {
      const rowHeight = baseHeight;
      if (doc.y + rowHeight > CONTENT_BOTTOM) addItemsPage(doc, order, options);
      drawItemSegment(doc, item, [], true, rowHeight, options);
      continue;
    }

    let offset = 0;
    let firstSegment = true;
    while (offset < codes.length) {
      const available = CONTENT_BOTTOM - doc.y;
      const maxFreshCodes = Math.max(1, Math.floor((CONTENT_BOTTOM - CONTENT_TOP - TABLE_HEAD_HEIGHT - baseHeight - 10) / CODE_LINE_HEIGHT));
      const remaining = codes.length - offset;
      const availableCodeSlots = Math.floor((available - 8) / CODE_LINE_HEIGHT);
      let take = Math.min(remaining, maxFreshCodes, availableCodeSlots);
      let rowHeight = Math.max(baseHeight, take * CODE_LINE_HEIGHT + 8);

      // Keep a reasonably sized product row together; split only when the code list
      // itself cannot fit on a single page.
      if (take < 1 || (remaining <= maxFreshCodes && rowHeight > available)) {
        addItemsPage(doc, order, options);
        continue;
      }
      if (rowHeight > available) {
        addItemsPage(doc, order, options);
        continue;
      }
      drawItemSegment(doc, item, codes.slice(offset, offset + take), firstSegment, rowHeight, options);
      offset += take;
      firstSegment = false;
      if (offset < codes.length) addItemsPage(doc, order, options);
    }
  }
};

const footerRowCount = (order) => {
  const fees = Array.isArray(order.extraFees) ? order.extraFees.filter((fee) => Number(fee?.amount) > 0).length : 0;
  const giftRows = (order.giftCodeRedemptions || []).filter((entry) => Number(entry?.appliedBDT) > 0).length;
  const hasRedemption = Number(order.loyaltyAmountUsed) > 0 || Number(order.giftCodeAmountUsed) > 0;
  const redemptionRows = hasRedemption ? 1 + (Number(order.loyaltyAmountUsed) > 0 ? 1 : 0) + giftRows : 0;
  return 3 + (Number(order.discountAmount) > 0 ? 1 : 0) + (order.couponCode ? 1 : 0) + (Number(order.tax) > 0 ? 1 : 0) + (fees || (Number(order.extraFeeTotal) > 0 ? 1 : 0)) + redemptionRows;
};

const drawTotals = (doc, order) => {
  const giftRedemptions = (order.giftCodeRedemptions || []).filter((entry) => Number(entry?.appliedBDT) > 0);
  const hasRedemption = Number(order.loyaltyAmountUsed) > 0 || Number(order.giftCodeAmountUsed) > 0;
  const rows = [
    ['Subtotal', currency(order.totalAmount)],
    ...(Number(order.discountAmount) > 0 ? [['Discount', `- ${currency(order.discountAmount)}`]] : []),
    ...(order.couponCode ? [['Coupon', safeString(order.couponCode)]] : []),
    ...(Number(order.tax) > 0 ? [['Tax', currency(order.tax)]] : []),
    ['Shipping', currency(order.shippingCost ?? order.shipping?.charge)],
    ...(Array.isArray(order.extraFees) && order.extraFees.some((fee) => Number(fee?.amount) > 0)
      ? order.extraFees.filter((fee) => Number(fee?.amount) > 0).map((fee) => [fee.label || 'Extra fee', currency(fee.amount)])
      : (Number(order.extraFeeTotal) > 0 ? [['Extra fees', currency(order.extraFeeTotal)]] : [])),
    ...(hasRedemption ? [
      ['Order total', currency(order.grandTotal)],
      ...(Number(order.loyaltyAmountUsed) > 0 ? [['Loyalty balance', `- ${currency(order.loyaltyAmountUsed)}`]] : []),
      ...giftRedemptions.map((entry) => [`Gift code ••••-${safeString(entry.codeSuffix || '')}`, `- ${currency(entry.appliedBDT)}`]),
    ] : []),
  ];
  const width = 255;
  const x = PAGE_WIDTH - MARGIN - width;
  const rowHeight = 17;
  const height = rows.length * rowHeight + 30;
  const y = doc.y;
  doc.roundedRect(x, y, width, height, 3).fillAndStroke('#FFFFFF', COLORS.line);
  rows.forEach(([label, value], index) => {
    const rowY = y + 9 + index * rowHeight;
    doc.fillColor(COLORS.gray).font('Helvetica').fontSize(7.5).text(label, x + 10, rowY, { width: 130, lineBreak: false });
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.5).text(value, x + 136, rowY, { width: width - 146, align: 'right', lineBreak: false, ellipsis: true });
  });
  const finalY = y + 9 + rows.length * rowHeight;
  doc.strokeColor(COLORS.ink).lineWidth(1).moveTo(x + 9, finalY - 3).lineTo(x + width - 9, finalY - 3).stroke();
  const hasAppliedBalance = hasRedemption;
  const finalAmount = hasAppliedBalance
    ? (Number.isFinite(Number(order.amountDue)) ? Number(order.amountDue) : Math.max(0, Number(order.grandTotal) - Number(order.loyaltyAmountUsed || 0) - Number(order.giftCodeAmountUsed || 0)))
    : Number(order.grandTotal);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10.5).text(hasAppliedBalance ? 'AMOUNT DUE' : 'TOTAL AMOUNT', x + 10, finalY + 3, { width: 130 });
  doc.fillColor(COLORS.red).font('Helvetica-Bold').fontSize(11).text(currency(finalAmount), x + 136, finalY + 2, { width: width - 146, align: 'right', lineBreak: false });
  doc.y = y + height;
};

const drawSignatureAndCertification = (doc) => {
  const y = doc.y + 10;
  const width = PAGE_WIDTH - MARGIN * 2;
  const gap = 10;
  const signatureWidth = (width - gap) / 2;
  const cardHeight = 96;
  doc.save();
  doc.roundedRect(MARGIN, y, signatureWidth, cardHeight, 3).strokeColor(COLORS.line).lineWidth(0.8).stroke();
  if (BRAND_SIGNATURE) {
    try {
      doc.image(BRAND_SIGNATURE, MARGIN + (signatureWidth - 126) / 2, y + 2, { fit: [126, 50], align: 'center', valign: 'center' });
    } catch {
      doc.fillColor(COLORS.red).font('Helvetica-Bold').fontSize(12).text(BRAND, MARGIN + 5, y + 22, { width: signatureWidth - 10, align: 'center' });
    }
  }
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.5).text('AUTHORIZED SIGNATURE', MARGIN + 5, y + 54, { width: signatureWidth - 10, align: 'center' });
  doc.strokeColor(COLORS.ink).lineWidth(0.6).moveTo(MARGIN + 37, y + 72).lineTo(MARGIN + signatureWidth - 37, y + 72).stroke();
  doc.fillColor(COLORS.gray).font('Helvetica').fontSize(6.7).text('BELORELLA Management', MARGIN + 5, y + 79, { width: signatureWidth - 10, align: 'center' });
  doc.restore();

  const certX = MARGIN + signatureWidth + gap;
  const certWidth = signatureWidth;
  const sealWidth = BRAND_SEAL ? 56 : 0;
  doc.save();
  doc.roundedRect(certX, y, certWidth, cardHeight, 3).fillAndStroke(COLORS.light, COLORS.line);
  doc.fillColor(COLORS.darkRed).font('Helvetica-Bold').fontSize(9).text('QUALITY CERTIFICATION', certX + 12, y + 11);
  const certifications = ['Genuine and authentic products', 'Quality checked before dispatch', '7-day return policy applies', 'Customer satisfaction guaranteed'];
  certifications.forEach((line, index) => {
    doc.fillColor(COLORS.red).circle(certX + 14, y + 31 + index * 12, 1.6).fill();
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(6.8).text(line, certX + 21, y + 27 + index * 12, { width: certWidth - 32 - sealWidth });
  });
  doc.fillColor(COLORS.gray).font('Helvetica-Bold').fontSize(7).text(`Thank you for choosing ${BRAND}!`, certX + 12, y + 79, { width: certWidth - 24 });
  if (BRAND_SEAL) {
    try {
      doc.image(BRAND_SEAL, certX + certWidth - 68, y + 20, { fit: [56, 56], align: 'center', valign: 'center' });
    } catch {
      // Keep the certification block readable if the optional seal image is invalid.
    }
  }
  doc.restore();
  doc.y = y + cardHeight;
};

const addRepeatingFooters = (doc, order) => {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    const pageNumber = range.start + index;
    doc.switchToPage(pageNumber);
    const originalBottomMargin = doc.page.margins.bottom;
    // Footer text belongs in the reserved page margin; relax PDFKit's automatic
    // text-flow boundary while drawing it so it cannot create an extra page.
    doc.page.margins.bottom = 10;
    doc.save();
    doc.strokeColor(COLORS.line).lineWidth(0.6).moveTo(MARGIN, PAGE_HEIGHT - 37).lineTo(PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 37).stroke();
    doc.fillColor(COLORS.gray).font('Helvetica-Bold').fontSize(7).text(BRAND, MARGIN, PAGE_HEIGHT - 28, { characterSpacing: 1 });
    doc.fillColor(COLORS.gray).font('Helvetica').fontSize(7).text(`Order #${safeString(order.orderId)}`, MARGIN + 90, PAGE_HEIGHT - 28);
    doc.fillColor(COLORS.gray).font('Helvetica').fontSize(7).text(`Page ${index + 1} of ${range.count}`, PAGE_WIDTH - MARGIN - 75, PAGE_HEIGHT - 28, { width: 75, align: 'right' });
    doc.restore();
    doc.page.margins.bottom = originalBottomMargin;
  }
};

const createOrderInvoicePdf = async (order, settings = {}) => {
  const options = {
    // Brand identity assets are mandatory on invoice PDFs, including email attachments.
    showLogo: true,
    includeSignature: true,
    includeQRCode: settings.includeQRCode !== false,
    includeBarcode: settings.includeBarcode !== false,
  };
  const items = await prepareInventoryCodes(normalizeInvoiceItems(order), options);
  const doc = new PDFDocument({ size: 'A4', margins: { top: CONTENT_TOP, right: MARGIN, bottom: 50, left: MARGIN }, bufferPages: true, autoFirstPage: true, info: { Title: `BELORELLA Order #${order.orderId}`, Author: BRAND, Subject: 'Order Invoice' } });
  const chunks = [];
  const pdf = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  drawPageHeader(doc, order, options);
  drawOrderInformation(doc, order);
  drawItems(doc, order, items, options);

  const totalsHeight = footerRowCount(order) * 17 + 30;
  const signatureHeight = 10 + 96;
  const copyrightHeight = 27;
  const footerGroupHeight = totalsHeight + 10 + signatureHeight + copyrightHeight;
  if (doc.y + footerGroupHeight > CONTENT_BOTTOM) {
    doc.addPage();
    drawPageHeader(doc, order, options);
  }
  drawTotals(doc, order);
  drawSignatureAndCertification(doc);
  doc.moveDown(0.7);
  doc.fillColor(COLORS.gray).font('Helvetica').fontSize(6.5).text(`© ${new Date().getFullYear()} ${BRAND}. All rights reserved. This invoice is computer generated.`, MARGIN, doc.y, { width: PAGE_WIDTH - MARGIN * 2, align: 'center' });
  addRepeatingFooters(doc, order);
  doc.end();
  return pdf;
};

module.exports = { createOrderInvoicePdf, __testables: { normalizeInvoiceItems, itemText } };
