const mongoose = require('mongoose');
const Order = require('../models/Order');
const POSOrder = require('../models/POSOrder');
const Product = require('../models/Product');
const Region = require('../models/Region');
const FinanceExpense = require('../models/FinanceExpense');

const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const idOf = (value) => value?._id ? String(value._id) : value ? String(value) : '';
const stringOf = (value) => String(value ?? '').trim();
const allocateByBase = (amount, rows, getBase) => {
  const total = round2(Math.max(0, Number(amount) || 0));
  const bases = rows.map((row) => Math.max(0, Number(getBase(row)) || 0));
  const denominator = bases.reduce((sum, base) => sum + base, 0);
  const lastPositiveIndex = bases.reduce((last, base, index) => base > 0 ? index : last, -1);
  let allocated = 0;
  return bases.map((base, index) => {
    if (base <= 0 || denominator <= 0 || total <= 0) return 0;
    const value = index === lastPositiveIndex ? round2(total - allocated) : round2(total * base / denominator);
    allocated = round2(allocated + value);
    return value;
  });
};
const dhakaDateParts = (value) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(value).filter((part) => part.type !== 'literal').map(({ type, value: partValue }) => [type, partValue]));
const dhakaDateKey = (value) => {
  const { year, month, day } = dhakaDateParts(value);
  return `${year}-${month}-${day}`;
};

const parseDateRange = (query) => {
  const now = new Date();
  const today = dhakaDateParts(now);
  const currentMonthStart = `${today.year}-${today.month}-01`;
  const currentDate = `${today.year}-${today.month}-${today.day}`;
  const parseBoundary = (value, isEnd) => {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    return dateOnly
      ? new Date(`${value}T${isEnd ? '23:59:59.999' : '00:00:00.000'}+06:00`)
      : new Date(value);
  };
  const start = parseBoundary(query.startDate || currentMonthStart, false);
  const end = parseBoundary(query.endDate || currentDate, true);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    const error = new Error('startDate and endDate must be valid dates');
    error.statusCode = 400;
    throw error;
  }
  if (start > end) {
    const error = new Error('startDate cannot be after endDate');
    error.statusCode = 400;
    throw error;
  }
  return { start, end, createdAt: { $gte: start, $lte: end } };
};

const userLabel = (user) => user?.fullName
  || [user?.firstName, user?.lastName].filter(Boolean).join(' ')
  || user?.email
  || 'Customer';

const variantLabel = (item) => {
  const configuration = item.configuration || {};
  const color = stringOf(configuration.color || item.color);
  const size = stringOf(configuration.size || item.size);
  return stringOf(item.variantName) || [color, size].filter(Boolean).join(' / ');
};

const makeOnlineRows = (order) => {
  const items = Array.isArray(order.items) ? order.items : [];
  const rawLines = items.map((item) => {
    const quantity = Math.max(0, Number(item.quantity) || 0);
    const grossUnitPrice = Number(item.originalPrice ?? item.price) || 0;
    const saleUnitPrice = Number(item.price) || 0;
    const saleBeforeCoupon = round2(saleUnitPrice * quantity);
    const catalogDiscount = round2(Math.max(0, (grossUnitPrice - saleUnitPrice) * quantity));
    const assigned = Array.isArray(item.assignedInventoryItems) ? item.assignedInventoryItems : [];
    const assignedSnapshots = Array.isArray(item.assignedInventorySnapshots) ? item.assignedInventorySnapshots : [];
    const barcode = item.barcode || assigned.map((inventory) => inventory?.barcode).filter(Boolean).join(', ');
    const completeAssignedCosts = assignedSnapshots.length >= quantity && assignedSnapshots.slice(0, quantity).every((snapshot) => snapshot.costPrice !== null && snapshot.costPrice !== undefined && Number.isFinite(Number(snapshot.costPrice)));
    const completeAssignedInventoryCosts = assigned.length >= quantity && assigned.slice(0, quantity).every((inventory) => inventory?.costPrice !== null && inventory?.costPrice !== undefined && Number.isFinite(Number(inventory.costPrice)));
    const rawCostPrice = item.costPrice;
    const costAmount = completeAssignedCosts
      ? assignedSnapshots.slice(0, quantity).reduce((sum, snapshot) => sum + Number(snapshot.costPrice), 0)
      : completeAssignedInventoryCosts
        ? assigned.slice(0, quantity).reduce((sum, inventory) => sum + Number(inventory.costPrice), 0)
        : rawCostPrice !== null && rawCostPrice !== undefined && Number.isFinite(Number(rawCostPrice)) ? Number(rawCostPrice) * quantity : null;
    return {
      source: 'online',
      sourceId: String(order._id),
      itemId: String(item._id || ''),
      orderId: String(order.orderId || order._id),
      orderInternalId: String(order._id),
      orderDate: order.createdAt,
      orderStatus: order.orderStatus || 'pending',
      paymentStatus: order.paymentStatus || 'pending',
      paymentMethod: order.paymentMethod || '',
      courier: order.courier?.service || '',
      trackingNumber: order.courier?.trackingNumber || order.courier?.consignmentId || '',
      customer: userLabel(order.userId),
      customerEmail: order.userId?.email || '',
      productId: idOf(item.productId),
      productName: stringOf(item.name) || 'Product',
      productSlug: stringOf(item.productSlug),
      productImage: stringOf(item.mainImage),
      brand: stringOf(item.brand),
      categories: Array.isArray(item.categories) ? item.categories.filter(Boolean) : [],
      variantId: idOf(item.variantId),
      variantName: variantLabel(item),
      regionId: idOf(item.regionId || item.configuration?.regionId),
      regionName: stringOf(item.regionName || item.configuration?.regionName),
      color: stringOf(item.configuration?.color || item.color),
      colorHex: stringOf(item.configuration?.hexCode || item.hexCode),
      size: stringOf(item.configuration?.size || item.size),
      measureType: stringOf(item.configuration?.measureType || item.measureType),
      unitName: stringOf(item.configuration?.unitName || item.unitName),
      sku: stringOf(item.sku),
      barcode: stringOf(barcode),
      quantity,
      grossUnitPrice,
      saleUnitPrice,
      catalogDiscount,
      couponDiscount: Math.max(0, Number(item.discountApplied) || 0),
      lineRevenue: saleBeforeCoupon,
      costPrice: costAmount === null || quantity <= 0 ? null : round2(costAmount / quantity),
      costAmount: costAmount === null ? null : round2(costAmount),
      tax: 0,
      shippingRevenue: 0,
      refundAmount: 0,
      returnAmount: 0,
      _order: order,
    };
  });

  const reportedCouponDiscount = Math.max(0, Number(order.discountAmount) || 0);
  const itemDiscountTotal = rawLines.reduce((sum, row) => sum + row.couponDiscount, 0);
  const couponDifference = Math.max(0, reportedCouponDiscount - itemDiscountTotal);
  const eligibleBase = rawLines.reduce((sum, row) => sum + row.lineRevenue, 0);
  rawLines.forEach((row) => {
    if (couponDifference > 0 && eligibleBase > 0) {
      row.couponDiscount += round2(couponDifference * row.lineRevenue / eligibleBase);
    }
    row.lineRevenue = round2(Math.max(0, row.lineRevenue - row.couponDiscount));
  });

  const refunded = order.paymentStatus === 'refunded' || order.refundStatus === 'approved';
  const returned = order.courier?.status === 'returned';
  const canceled = order.orderStatus === 'cancelled' || order.isActive === false;
  const eligibleForSale = !refunded && !returned && !canceled && order.paymentStatus !== 'failed';
  const orderRefund = refunded ? Math.max(0, Number(order.refundAmount) || Number(order.grandTotal) || Number(order.totalAmount) || 0) : 0;
  const orderReturn = returned && !refunded ? rawLines.reduce((sum, row) => sum + row.lineRevenue, 0) : 0;
  const shippingTotal = round2(Number(order.shippingCost ?? order.shipping?.charge) || 0) + round2(Number(order.extraFeeTotal) || 0);
  const shippingAllocations = eligibleForSale ? allocateByBase(shippingTotal, rawLines, (row) => row.lineRevenue) : [];
  const refundAllocations = allocateByBase(orderRefund, rawLines, (row) => row.lineRevenue);
  const returnAllocations = allocateByBase(orderReturn, rawLines, (row) => row.lineRevenue);

  rawLines.forEach((row, index) => {
    row.shippingRevenue = shippingAllocations[index] || 0;
    row.refundAmount = refundAllocations[index] || 0;
    row.returnAmount = returnAllocations[index] || 0;
    row.isSale = eligibleForSale;
    row.isRefunded = refunded;
    row.isReturned = returned;
    row.profit = row.costPrice === null ? null : round2(row.lineRevenue - row.costAmount);
    row.profitMargin = row.costPrice === null || row.lineRevenue <= 0 ? null : round2(row.profit / row.lineRevenue * 100);
    delete row._order;
  });
  return rawLines;
};

const makePOSRows = (order) => {
  const refunded = order.paymentStatus === 'refunded' || order.orderStatus === 'refunded';
  const returned = order.orderStatus === 'returned';
  const totalRefund = Math.min(Number(order.total) || 0, Math.max(0, Number(order.refundAmount) || (refunded ? Number(order.total) || 0 : 0)));
  const rows = (order.items || []).map((item) => {
  const inventory = item.inventoryId && typeof item.inventoryId === 'object' ? item.inventoryId : null;
  const quantity = Math.max(0, Number(item.quantity) || 0);
  const grossUnitPrice = Number(item.unitPrice) || 0;
  const saleUnitPrice = Number(item.discountPrice) > 0 ? Number(item.discountPrice) : grossUnitPrice;
  const grossLine = round2(grossUnitPrice * quantity);
  const saleLine = round2(Number(item.totalPrice) || saleUnitPrice * quantity);
  const orderDiscount = Math.max(0, Number(order.discount) || 0);
  const orderSubtotal = Math.max(0, Number(order.subtotal) || 0);
  const allocatedDiscount = orderSubtotal > 0 ? round2(orderDiscount * saleLine / orderSubtotal) : 0;
  const allocatedTax = orderSubtotal > 0 ? round2((Number(order.tax) || 0) * saleLine / orderSubtotal) : 0;
  const variant = item.variantInfo || {};
  const revenue = round2(Math.max(0, saleLine - allocatedDiscount));
  const rawCostPrice = item.costPrice ?? inventory?.costPrice;
  const costPrice = rawCostPrice !== null && rawCostPrice !== undefined && Number.isFinite(Number(rawCostPrice)) ? Number(rawCostPrice) : null;
  const costAmount = costPrice === null ? null : round2(costPrice * quantity);
  const eligibleForSale = !refunded && !returned && !['cancelled', 'failed'].includes(order.orderStatus) && order.paymentStatus !== 'failed';
  const returnAmount = returned && !refunded ? revenue : 0;
  return {
    source: 'pos',
    sourceId: String(order._id),
    itemId: String(item._id || ''),
    orderId: String(order.orderNumber || order._id),
    orderInternalId: String(order._id),
    orderDate: order.createdAt,
    orderStatus: order.orderStatus || 'completed',
    paymentStatus: order.paymentStatus || 'completed',
    paymentMethod: order.paymentMethod || '',
    courier: '',
    trackingNumber: '',
    customer: stringOf(order.customer?.name) || 'Walk-in Customer',
    customerEmail: stringOf(order.customer?.email),
    productId: idOf(item.productId),
    productName: stringOf(item.productName) || 'Product',
    productSlug: stringOf(item.productSlug),
    productImage: stringOf(variant.imageUrl),
    brand: stringOf(item.brand),
    categories: Array.isArray(item.categories) ? item.categories.filter(Boolean) : [],
    variantId: idOf(item.variantId || variant.variantId),
    variantName: stringOf(variant.variantName) || [variant.color, variant.size].filter(Boolean).join(' / '),
    regionId: idOf(variant.regionId || inventory?.regionId),
    regionName: stringOf(variant.regionName || inventory?.regionName),
    color: stringOf(variant.color || inventory?.color?.name),
    colorHex: stringOf(variant.hexCode || inventory?.color?.hexCode),
    size: stringOf(variant.size || inventory?.size),
    measureType: stringOf(variant.measureType),
    unitName: stringOf(variant.unitName),
    sku: stringOf(item.sku || variant.sku),
    barcode: stringOf(item.scannedBarcode || variant.barcode || inventory?.barcode),
    quantity,
    grossUnitPrice,
    saleUnitPrice,
    catalogDiscount: round2(Math.max(0, grossLine - saleLine)),
    couponDiscount: allocatedDiscount,
    lineRevenue: eligibleForSale ? revenue : 0,
    costPrice,
    costAmount,
    tax: eligibleForSale ? allocatedTax : 0,
    shippingRevenue: 0,
    refundAmount: 0,
    returnAmount,
    isSale: eligibleForSale,
    isRefunded: refunded,
    isReturned: returned,
    profit: costPrice === null ? null : round2(revenue - costAmount),
    profitMargin: costPrice === null || revenue <= 0 ? null : round2((revenue - costAmount) / revenue * 100),
    _refundAllocationBase: revenue,
  };
  });

  const refundAllocations = allocateByBase(totalRefund, rows, (row) => row._refundAllocationBase);
  rows.forEach((row, index) => {
    if (totalRefund > 0) {
      row.refundAmount = refundAllocations[index] || 0;
      if (row.isSale) row.lineRevenue = round2(Math.max(0, row.lineRevenue - row.refundAmount));
      row.profit = row.costPrice === null ? null : round2(row.lineRevenue - row.costAmount);
      row.profitMargin = row.costPrice === null || row.lineRevenue <= 0 ? null : round2(row.profit / row.lineRevenue * 100);
    }
    delete row._refundAllocationBase;
  });
  return rows;
};

const enrichLegacyRows = async (rows) => {
  const ids = [...new Set(rows.filter((row) => row.productId && (
    !row.brand || !row.categories.length || !row.productSlug || !row.sku || !row.regionName || !row.color || !row.measureType
  )).map((row) => row.productId))]
    .filter(mongoose.isValidObjectId);
  const products = ids.length
    ? await Product.find({ _id: { $in: ids } })
      .select('sku brand categories slug mainImage regionId variants')
      .populate('regionId', 'name')
      .populate('variants.regionId', 'name')
      .lean()
    : [];
  const byId = new Map(products.map((product) => [String(product._id), product]));
  const missingRegionIds = [...new Set(rows
    .filter((row) => row.regionId && !row.regionName && mongoose.isValidObjectId(row.regionId))
    .map((row) => String(row.regionId)))];
  const regions = missingRegionIds.length
    ? await Region.find({ _id: { $in: missingRegionIds } }).select('name').lean()
    : [];
  const regionNames = new Map(regions.map((region) => [String(region._id), region.name]));

  return rows.map((row) => {
    const product = byId.get(row.productId);
    if (!product) return { ...row, regionName: row.regionName || regionNames.get(row.regionId) || '' };
    const variant = row.variantId
      ? product.variants?.find((candidate) => String(candidate._id) === row.variantId)
      : product.variants?.length === 1 ? product.variants[0] : null;
    const options = Array.isArray(variant?.options) ? variant.options : [];
    const selectedOption = options.find((option) => String(option.size || '').trim().toLowerCase() === String(row.size || '').trim().toLowerCase())
      || (options.length === 1 ? options[0] : null);
    const variantRegion = variant?.regionId && typeof variant.regionId === 'object' ? variant.regionId : null;
    const productRegion = product.regionId && typeof product.regionId === 'object' ? product.regionId : null;
    const fallbackRegionName = regionNames.get(row.regionId)
      || (row.regionId && String(productRegion?._id || '') === row.regionId ? productRegion?.name : '')
      || (!row.regionId && !variantRegion ? productRegion?.name : '')
      || '';
    const color = row.color || variant?.colorName || '';
    const size = row.size || selectedOption?.size || '';
    const measureType = row.measureType || selectedOption?.measureType || variant?.measureType || '';
    const unitName = row.unitName || selectedOption?.unitName || variant?.unitName || '';

    return {
      ...row,
      brand: row.brand || product.brand || '',
      categories: row.categories.length ? row.categories : product.categories || [],
      productSlug: row.productSlug || product.slug || '',
      productImage: row.productImage || product.mainImage || '',
      sku: row.sku || variant?.sku || product.sku || '',
      regionName: row.regionName || variantRegion?.name || fallbackRegionName,
      color,
      colorHex: row.colorHex || variant?.hexCode || '',
      size,
      measureType,
      unitName,
      variantName: row.variantName || [color, size].filter(Boolean).join(' / '),
    };
  });
};

const loadFinanceRows = async (query) => {
  const range = parseDateRange(query);
  const [orders, posOrders] = await Promise.all([
    Order.find({ createdAt: range.createdAt })
      .select('orderId userId items totalAmount discountAmount shippingCost shipping extraFeeTotal grandTotal refundAmount refundStatus paymentStatus paymentMethod orderStatus isActive courier createdAt')
      .populate('userId', 'fullName firstName lastName email')
      .populate('items.assignedInventoryItems', 'barcode costPrice')
      .sort({ createdAt: -1 }).lean(),
    POSOrder.find({ createdAt: range.createdAt })
      .select('orderNumber customer items subtotal tax discount total refundAmount paymentStatus paymentMethod orderStatus createdAt')
      .populate({ path: 'items.inventoryId', select: 'barcode qrCode costPrice regionId regionName size color productId' })
      .sort({ createdAt: -1 }).lean(),
  ]);
  let rows = [...orders.flatMap(makeOnlineRows), ...posOrders.flatMap(makePOSRows)];
  rows = await enrichLegacyRows(rows);
  return { rows, orders, posOrders, range };
};

const filterRows = (rows, query) => {
  const q = stringOf(query.search).toLowerCase();
  const match = (actual, expected) => !expected || String(actual || '').toLowerCase() === String(expected).toLowerCase();
  return rows.filter((row) => {
    if (query.productId && row.productId !== String(query.productId)) return false;
    if (query.variantId && row.variantId !== String(query.variantId)) return false;
    if (query.product && !row.productName.toLowerCase().includes(String(query.product).toLowerCase())) return false;
    if (query.variant && !row.variantName.toLowerCase().includes(String(query.variant).toLowerCase())) return false;
    if (query.sku && !row.sku.toLowerCase().includes(String(query.sku).toLowerCase())) return false;
    if (query.barcode && !row.barcode.toLowerCase().includes(String(query.barcode).toLowerCase())) return false;
    if (query.orderId && !row.orderId.toLowerCase().includes(String(query.orderId).toLowerCase())) return false;
    if (query.customer && !row.customer.toLowerCase().includes(String(query.customer).toLowerCase())) return false;
    if (!match(row.paymentStatus, query.paymentStatus)) return false;
    if (!match(row.orderStatus, query.orderStatus)) return false;
    if (query.courier && row.courier.toLowerCase() !== String(query.courier).toLowerCase()) return false;
    if (query.productCategory && !row.categories.some((category) => stringOf(category?.name || category).toLowerCase() === String(query.productCategory).toLowerCase())) return false;
    if (query.productBrand && row.brand.toLowerCase() !== String(query.productBrand).toLowerCase()) return false;
    if (query.profitable === 'yes' && !(row.profit > 0)) return false;
    if (query.profitable === 'no' && !(row.profit !== null && row.profit <= 0)) return false;
    if (q) {
      const haystack = [row.productName, row.variantName, row.sku, row.barcode, row.orderId, row.customer, row.brand, ...row.categories.map((category) => stringOf(category?.name || category))].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
};

const groupRows = (rows, keyFn) => {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    let group = groups.get(key);
    if (!group) {
      group = {
        _id: key,
        productId: row.productId,
        productName: row.productName,
        productSlug: row.productSlug,
        productImage: row.productImage,
        brand: row.brand,
        categories: row.categories,
        variantId: row.variantId,
        variantName: row.variantName,
        color: row.color,
        colorHex: row.colorHex,
        regionId: row.regionId,
        regionName: row.regionName,
        size: row.size,
        measureType: row.measureType,
        unitName: row.unitName,
        sku: row.sku,
        barcode: row.barcode,
        totalSold: 0,
        totalQuantity: 0,
        revenue: 0,
        grossSales: 0,
        discounts: 0,
        refunds: 0,
        returns: 0,
        knownCost: 0,
        missingCostQuantity: 0,
        profit: 0,
        profitIsComplete: true,
        orderIds: new Set(),
      };
      groups.set(key, group);
    }
    group.refunds += row.refundAmount;
    group.returns += row.returnAmount;
    if (!row.isSale) continue;
    group.totalSold += row.quantity;
    group.totalQuantity += row.quantity;
    group.revenue += row.lineRevenue;
    group.grossSales += row.grossUnitPrice * row.quantity;
    group.discounts += row.catalogDiscount + row.couponDiscount;
    group.orderIds.add(row.source + ':' + row.sourceId);
    if (row.costPrice === null) {
      group.missingCostQuantity += row.quantity;
      group.profitIsComplete = false;
    } else {
      group.knownCost += row.costAmount;
      group.profit += row.profit || 0;
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    name: group.productName,
    revenue: round2(group.revenue),
    grossSales: round2(group.grossSales),
    discounts: round2(group.discounts),
    refunds: round2(group.refunds),
    returns: round2(group.returns),
    knownCost: round2(group.knownCost),
    profit: group.profitIsComplete ? round2(group.profit) : null,
    estimatedProfit: round2(group.revenue - group.knownCost),
    profitIsEstimated: !group.profitIsComplete,
    orderCount: group.orderIds.size,
    orderIds: undefined,
  }));
};

const getOverview = async (req, res) => {
  try {
    const { rows, orders, posOrders, range } = await loadFinanceRows(req.query);
    const filteredRows = filterRows(rows, req.query);
    const saleRows = filteredRows.filter((row) => row.isSale);
    const selectedOrderIds = new Set(filteredRows.map((row) => `${row.source}:${row.sourceId}`));

    const grossSales = round2(saleRows.reduce((sum, row) => sum + row.grossUnitPrice * row.quantity, 0));
    const discounts = round2(saleRows.reduce((sum, row) => sum + row.catalogDiscount + row.couponDiscount, 0));
    const refunds = round2(filteredRows.reduce((sum, row) => sum + row.refundAmount, 0));
    const returns = round2(filteredRows.reduce((sum, row) => sum + row.returnAmount, 0));
    // Cancelled/refunded/returned orders are excluded from active net sales;
    // refunds and returns remain visible as separate reversal totals.
    const netSales = round2(saleRows.reduce((sum, row) => sum + row.lineRevenue, 0));
    const shippingRevenue = round2(saleRows.reduce((sum, row) => sum + row.shippingRevenue, 0));
    const totalRevenue = round2(netSales + shippingRevenue);
    const costKnown = round2(saleRows.reduce((sum, row) => sum + (row.costPrice === null ? 0 : row.costPrice * row.quantity), 0));
    const missingCostQuantity = saleRows.reduce((sum, row) => sum + (row.costPrice === null ? row.quantity : 0), 0);
    const soldQuantity = saleRows.reduce((sum, row) => sum + row.quantity, 0);

    const expenseQuery = { date: { $gte: range.start, $lte: range.end } };
    const allExpenses = await FinanceExpense.find(expenseQuery).select('amount category date').lean();
    const totalExpenses = round2(allExpenses.reduce((sum, expense) => sum + expense.amount, 0));
    const shippingExpenses = round2(allExpenses.filter((expense) => expense.category.toLowerCase() === 'shipping').reduce((sum, expense) => sum + expense.amount, 0));
    const otherExpenses = round2(totalExpenses - shippingExpenses);
    const estimatedProfit = round2(totalRevenue - costKnown - totalExpenses);
    const profitIsComplete = missingCostQuantity === 0;
    const orderCount = selectedOrderIds.size;
    const hasScopedFilters = Boolean(req.query.productCategory || req.query.productBrand || req.query.productId || req.query.variantId || req.query.product || req.query.variant || req.query.sku || req.query.barcode || req.query.orderId || req.query.customer || req.query.search);
    const grossProfitEstimate = round2(netSales - costKnown);

    const revenueByDate = new Map();
    for (const row of saleRows) {
      const date = dhakaDateKey(row.orderDate);
      revenueByDate.set(date, round2((revenueByDate.get(date) || 0) + row.lineRevenue + row.shippingRevenue));
    }
    const expenseByDate = new Map();
    const expenseByCategory = new Map();
    for (const expense of allExpenses) {
      const date = dhakaDateKey(expense.date);
      expenseByDate.set(date, round2((expenseByDate.get(date) || 0) + expense.amount));
      expenseByCategory.set(expense.category, round2((expenseByCategory.get(expense.category) || 0) + expense.amount));
    }
    const dailyRevenue = [...revenueByDate].sort(([a], [b]) => a.localeCompare(b)).map(([_id, revenue]) => ({ _id, revenue }));
    const dailyExpenses = [...expenseByDate].sort(([a], [b]) => a.localeCompare(b)).map(([_id, amount]) => ({ _id, amount }));

    const monthlyComparison = [];
    const startParts = dhakaDateParts(range.start);
    const endParts = dhakaDateParts(range.end);
    const cursor = new Date(Date.UTC(Number(startParts.year), Number(startParts.month) - 1, 1));
    const lastMonth = new Date(Date.UTC(Number(endParts.year), Number(endParts.month) - 1, 1));
    while (cursor <= lastMonth && monthlyComparison.length < 24) {
      const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
      const label = cursor.toLocaleDateString('en-BD', { timeZone: 'UTC', month: 'short', year: 'numeric' });
      const monthRevenue = saleRows.filter((row) => {
        const parts = dhakaDateParts(row.orderDate);
        return Number(parts.year) === cursor.getUTCFullYear() && Number(parts.month) - 1 === cursor.getUTCMonth();
      }).reduce((sum, row) => sum + row.lineRevenue + row.shippingRevenue, 0);
      const monthExpenses = allExpenses.filter((expense) => {
        const parts = dhakaDateParts(expense.date);
        return Number(parts.year) === cursor.getUTCFullYear() && Number(parts.month) - 1 === cursor.getUTCMonth();
      }).reduce((sum, expense) => sum + expense.amount, 0);
      monthlyComparison.push({ key, label, revenue: round2(monthRevenue), expenses: round2(monthExpenses) });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    const orderStatusCounts = new Map();
    [...orders, ...posOrders].forEach((order) => {
      const key = `${order.orderNumber ? 'pos' : 'online'}:${order._id}`;
      if (!selectedOrderIds.has(key)) return;
      const status = order.orderStatus || 'unknown';
      orderStatusCounts.set(status, (orderStatusCounts.get(status) || 0) + 1);
    });

    const allProducts = groupRows(filteredRows, (row) => row.productId || row.productName);
    const topProducts = allProducts.filter((row) => row.totalSold > 0).sort((a, b) => b.revenue - a.revenue || b.totalSold - a.totalSold).slice(0, 25);
    const allVariants = groupRows(filteredRows, (row) => [row.productId, row.variantId, row.sku, row.color, row.size, row.regionId].join(':'));
    const allVariantDetails = [...allVariants]
      .filter((row) => row.totalSold > 0 || row.refunds > 0 || row.returns > 0)
      .sort((a, b) => b.revenue - a.revenue || a.productName.localeCompare(b.productName) || a.variantName.localeCompare(b.variantName));
    const topVariants = [...allVariants].filter((row) => row.totalSold > 0).sort((a, b) => b.revenue - a.revenue || b.totalSold - a.totalSold).slice(0, 100);
    const topProfitProducts = allProducts.filter((row) => row.profit !== null).sort((a, b) => b.profit - a.profit).slice(0, 25);
    const lowPerformingProducts = allProducts.filter((row) => row.totalSold > 0).sort((a, b) => a.revenue - b.revenue || a.totalSold - b.totalSold).slice(0, 25);
    const mostDiscountedProducts = [...allProducts].filter((row) => row.discounts > 0).sort((a, b) => b.discounts - a.discounts).slice(0, 25);
    const returnHeavyProducts = [...allProducts].filter((row) => row.returns > 0).sort((a, b) => b.returns - a.returns).slice(0, 25);
    const topSellingVariants = [...allVariants].sort((a, b) => b.totalSold - a.totalSold || b.revenue - a.revenue).slice(0, 25);
    const topProfitVariants = [...allVariants].filter((row) => row.profit !== null).sort((a, b) => b.profit - a.profit).slice(0, 25);
    const lowPerformingVariants = [...allVariants].sort((a, b) => a.revenue - b.revenue).slice(0, 25);
    const mostDiscountedVariants = [...allVariants].sort((a, b) => b.discounts - a.discounts).slice(0, 25);
    const returnHeavyVariants = [...allVariants].filter((row) => row.returns > 0).sort((a, b) => b.returns - a.returns).slice(0, 25);
    const topSellingProducts = [...topProducts].sort((a, b) => b.totalSold - a.totalSold || b.revenue - a.revenue).slice(0, 25);
    const allCostKnown = profitIsComplete && saleRows.length > 0;
    return res.json({ success: true, overview: {
      grossSales,
      totalRevenue,
      netSales,
      discounts,
      refunds,
      returns,
      shippingRevenue,
      shippingExpenses,
      otherExpenses,
      totalExpenses,
      costOfGoodsKnown: costKnown,
      missingCostQuantity,
      soldQuantity,
      profit: allCostKnown ? (hasScopedFilters ? grossProfitEstimate : estimatedProfit) : null,
      estimatedProfit: hasScopedFilters ? grossProfitEstimate : estimatedProfit,
      profitIsEstimated: !allCostKnown,
      profitBasis: hasScopedFilters ? 'gross_before_overhead' : 'net_after_expenses',
      costCoveragePercent: soldQuantity ? round2((soldQuantity - missingCostQuantity) / soldQuantity * 100) : 0,
      orderCount,
      dailyRevenue,
      dailyExpenses,
      expenseByCategory: [...expenseByCategory].map(([_id, total]) => ({ _id, total })),
      monthlyComparison,
      topProducts,
      topRevenueProducts: topProducts,
      topSellingProducts,
      topProfitProducts,
      lowPerformingProducts,
      mostDiscountedProducts,
      returnHeavyProducts,
      topVariants,
      allVariants: allVariantDetails,
      topRevenueVariants: topVariants.slice(0, 25),
      topSellingVariants,
      topProfitVariants,
      lowPerformingVariants,
      mostDiscountedVariants,
      returnHeavyVariants,
      orderStatus: [...orderStatusCounts].map(([_id, count]) => ({ _id, count })),
    } });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to load finance overview' });
  }
};

const getTransactions = async (req, res) => {
  try {
    const { rows } = await loadFinanceRows(req.query);
    const filtered = filterRows(rows, req.query).sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const start = (page - 1) * limit;
    return res.json({ success: true, transactions: filtered.slice(start, start + limit), pagination: { page, limit, total: filtered.length, pages: Math.ceil(filtered.length / limit) } });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to load finance transactions' });
  }
};

const csvCell = (value) => {
  let text = Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

const exportTransactionsCsv = async (req, res) => {
  try {
    const { rows } = await loadFinanceRows(req.query);
    const filtered = filterRows(rows, req.query).sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
    const maxExportRows = 50000;
    const columns = [
      ['Date', (row) => row.orderDate], ['Order', (row) => row.orderId], ['Source', (row) => row.source],
      ['Product ID', (row) => row.productId], ['Product', (row) => row.productName], ['Product slug', (row) => row.productSlug], ['Image', (row) => row.productImage],
      ['Brand', (row) => row.brand], ['Category', (row) => row.categories], ['Variant ID', (row) => row.variantId], ['Variant', (row) => row.variantName],
      ['Region ID', (row) => row.regionId], ['Region', (row) => row.regionName], ['Color', (row) => row.color], ['Color hex', (row) => row.colorHex],
      ['Size', (row) => row.size], ['Measure type', (row) => row.measureType], ['Unit', (row) => row.unitName],
      ['SKU', (row) => row.sku], ['Barcode', (row) => row.barcode],
      ['Qty', (row) => row.quantity], ['Unit Price', (row) => row.grossUnitPrice], ['Final Unit Price', (row) => row.saleUnitPrice],
      ['Discount', (row) => row.catalogDiscount + row.couponDiscount], ['Revenue', (row) => row.isSale ? row.lineRevenue : 0], ['Cost', (row) => row.costPrice === null ? '' : row.costAmount],
      ['Profit', (row) => !row.isSale || row.profit === null ? '' : row.profit], ['Profit margin %', (row) => !row.isSale || row.profitMargin === null ? '' : row.profitMargin],
      ['Tax', (row) => row.tax], ['Customer-paid shipping', (row) => row.shippingRevenue], ['Refund', (row) => row.refundAmount], ['Return', (row) => row.returnAmount],
      ['Final financial amount', (row) => round2(row.isSale ? row.lineRevenue + row.shippingRevenue : 0)],
      ['Order Status', (row) => row.orderStatus], ['Payment Status', (row) => row.paymentStatus],
      ['Courier', (row) => row.courier], ['Tracking', (row) => row.trackingNumber], ['Customer', (row) => row.customer],
    ];
    const csv = [columns.map(([name]) => csvCell(name)).join(','), ...filtered.slice(0, maxExportRows).map((row) => columns.map(([, value]) => csvCell(value(row))).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="belorella-finance-transactions.csv"');
    if (filtered.length > maxExportRows) res.setHeader('X-Export-Truncated', String(filtered.length - maxExportRows));
    return res.send(`\uFEFF${csv}`);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to export finance transactions' });
  }
};

const getExpenses = async (req, res) => {
  try {
    const { start, end } = parseDateRange(req.query);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { date: { $gte: start, $lte: end } };
    if (req.query.category) filter.category = String(req.query.category).trim();
    if (req.query.search) {
      const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ title: { $regex: escaped, $options: 'i' } }, { notes: { $regex: escaped, $options: 'i' } }];
    }
    const [expenses, total] = await Promise.all([
      FinanceExpense.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      FinanceExpense.countDocuments(filter),
    ]);
    return res.json({ success: true, expenses, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to load expenses' });
  }
};

const expensePayload = (body) => {
  const title = stringOf(body.title);
  const category = stringOf(body.category);
  const amount = Number(body.amount);
  const date = new Date(body.date);
  if (!title || !category || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(date.getTime())) {
    const error = new Error('Title, category, a positive amount, and a valid date are required');
    error.statusCode = 400;
    throw error;
  }
  return { title, category, amount: round2(amount), date, notes: stringOf(body.notes) };
};

const createExpense = async (req, res) => {
  try {
    const expense = await FinanceExpense.create({ ...expensePayload(req.body), createdBy: req.admin?._id || req.admin?.id || null });
    return res.status(201).json({ success: true, expense });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to create expense' });
  }
};

const updateExpense = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense ID' });
    const expense = await FinanceExpense.findByIdAndUpdate(req.params.id, expensePayload(req.body), { new: true, runValidators: true });
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
    return res.json({ success: true, expense });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Unable to update expense' });
  }
};

const deleteExpense = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense ID' });
    const expense = await FinanceExpense.findByIdAndDelete(req.params.id);
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
    return res.json({ success: true, message: 'Expense deleted' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to delete expense' });
  }
};

module.exports = {
  getOverview,
  getTransactions,
  exportTransactionsCsv,
  getExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  __testables: { parseDateRange, makeOnlineRows, makePOSRows, filterRows, groupRows, csvCell },
};
