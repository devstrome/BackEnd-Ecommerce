const firstText = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const formatMeasureParts = (item = {}) => {
  const configuration = item.configuration || {};
  const variantInfo = item.variantInfo || {};
  const variant = item.variantId && typeof item.variantId === 'object' ? item.variantId : {};
  const inventory = item.inventoryId && typeof item.inventoryId === 'object' ? item.inventoryId : {};
  const product = item.productId && typeof item.productId === 'object' ? item.productId : {};
  const size = firstText(item.size, configuration.size, variantInfo.size, variant.size, inventory.size, product.defaultSize);
  const unit = firstText(item.unitName, configuration.unitName, variantInfo.unitName, variant.unitName, inventory.unitName, product.unitName);
  const label = firstText(item.measureType, configuration.measureType, variantInfo.measureType, variant.measureType, inventory.measureType, product.measureType, 'Size');

  let baseSize = size;
  if (size && unit) {
    const unitSuffix = new RegExp(`\\s*${escapeRegExp(unit)}\\s*$`, 'i');
    let candidate = size;
    while (unitSuffix.test(candidate)) {
      const withoutUnit = candidate.replace(unitSuffix, '').trim();
      if (!withoutUnit) break;
      candidate = withoutUnit;
    }
    baseSize = candidate;
  }

  const value = unit && baseSize && baseSize.toLowerCase() !== unit.toLowerCase()
    ? `${baseSize} ${unit}`
    : (size || unit);
  return { label, value };
};

const formatMeasureText = (item) => {
  const { label, value } = formatMeasureParts(item);
  return value ? `${label}: ${value}` : '';
};

module.exports = { formatMeasureParts, formatMeasureText };
