const Region = require('../models/Region');

const norm = (value) => String(value ?? '').trim().toLowerCase();
const idOf = (value) => String(value?._id || value || '');
const fail = (message, statusCode = 422) => Object.assign(new Error(message), { statusCode });

function indexForSize(variant, size) {
  const sizes = Array.isArray(variant?.sizes) ? variant.sizes : [];
  if (sizes.length === 0 && !size) return 0;
  return sizes.findIndex((candidate) => norm(candidate) === norm(size));
}

/**
 * Resolve the current sellable price and stock for a product configuration.
 * Accepts both the new options[] model and the older sizes/prices arrays.
 */
async function resolveProductConfiguration(product, selected = {}) {
  if (!product) throw fail('Product is unavailable', 404);

  const variants = Array.isArray(product.variants) ? product.variants : [];
  const selectedRegionId = idOf(selected.regionId || selected.region);
  const productRegionId = idOf(product.regionId);
  const productRegions = (product.regions || []).map(idOf).filter(Boolean);
  const variantRegions = [...new Set(variants.map((variant) => idOf(variant.regionId)).filter(Boolean))];
  const allRegions = [...new Set([...productRegions, ...variantRegions, productRegionId].filter(Boolean))];

  let regionId = selectedRegionId || productRegionId || (allRegions.length === 1 ? allRegions[0] : '');
  if (!regionId && allRegions.length > 1) throw fail('Select a region for this product');
  if (selectedRegionId && allRegions.length && !allRegions.includes(selectedRegionId)) {
    throw fail('This product is not available in the selected region');
  }

  let region = selected.regionName || selected.regionLabel || '';
  if (regionId) {
    const matchedRegion = await Region.findById(regionId).select('name isActive').lean();
    if (!matchedRegion || !matchedRegion.isActive) throw fail('The selected region is unavailable');
    region = matchedRegion.name;
  }

  let variant = null;
  if (variants.length) {
    const regionVariants = variants.filter((candidate) => {
      const candidateRegion = idOf(candidate.regionId);
      return !regionId || !candidateRegion || candidateRegion === regionId;
    });
    const variantId = idOf(selected.variantId);
    const color = norm(selected.color || selected.colorName);
    variant = regionVariants.find((candidate) => variantId && idOf(candidate._id) === variantId)
      || regionVariants.find((candidate) => color && norm(candidate.colorName) === color)
      || null;
    if (!variant) {
      if (selected.variantId || selected.color || selected.colorName || regionVariants.length) {
        throw fail('The selected color is no longer available in this region');
      }
    }
  }

  let option = null;
  let price;
  let discountPrice;
  let stock = null;
  let size = String(selected.size || '').trim();
  let measureType = String(selected.measureType || '').trim();
  let unitName = String(selected.unitName || '').trim();

  if (variant && Array.isArray(variant.options) && variant.options.length) {
    const options = variant.options;
    if (options.length > 1 && !size && !measureType && !unitName) {
      throw fail('Select a size or measure for this product');
    }
    option = options.find((candidate) => {
      const sizeMatches = !size || norm(candidate.size) === norm(size);
      const measureMatches = !measureType || norm(candidate.measureType) === norm(measureType);
      const unitMatches = !unitName || norm(candidate.unitName) === norm(unitName);
      return sizeMatches && measureMatches && unitMatches;
    }) || null;
    if (!option && options.length === 1 && !size) option = options[0];
    if (!option) throw fail('The selected size or measure is no longer available');
    size = String(option.size || size || '').trim();
    measureType = String(option.measureType || measureType || product.measureType || '').trim();
    unitName = String(option.unitName || unitName || product.unitName || '').trim();
    price = Number(option.price);
    discountPrice = Number(option.discountPrice);
    stock = Number(option.stock);
  } else if (variant) {
    const sizeIndex = indexForSize(variant, size);
    if (sizeIndex < 0) throw fail('The selected size is no longer available');
    size = String(variant.sizes?.[sizeIndex] || size || '').trim();
    measureType = String(variant.measureType || measureType || product.measureType || '').trim();
    unitName = String(variant.unitName || unitName || product.unitName || '').trim();
    price = Number(variant.prices?.[sizeIndex] ?? variant.price);
    discountPrice = Number(variant.discountPrices?.[sizeIndex] ?? variant.discountPrice);
    stock = Number(variant.stockBySize?.[sizeIndex] ?? variant.stock);
  } else {
    price = Number(product.mainPrice);
    discountPrice = Number(product.discountPrice);
    stock = Number.isFinite(Number(product.stock)) ? Number(product.stock) : null;
    size = size || String(product.defaultSize || '').trim();
    measureType = measureType || String(product.measureType || '').trim();
    unitName = unitName || String(product.unitName || '').trim();
  }

  if (!Number.isFinite(price) || price <= 0) throw fail('This product configuration has an invalid price');
  if (!Number.isFinite(discountPrice) || discountPrice < 0) discountPrice = 0;
  if (discountPrice > price) throw fail('Discount price cannot exceed the original price');
  if (!Number.isFinite(stock) || stock < 0) stock = null;

  const finalPrice = discountPrice > 0 && discountPrice < price ? discountPrice : price;
  return {
    productId: product._id,
    regionId: regionId || null,
    regionName: region || '',
    variantId: variant?._id || selected.variantId || null,
    color: String(variant?.colorName || selected.color || selected.colorName || '').trim(),
    hexCode: String(variant?.hexCode || selected.hexCode || '').trim(),
    size,
    measureType,
    unitName,
    price,
    discountPrice: discountPrice > 0 && discountPrice < price ? discountPrice : null,
    finalPrice,
    stock,
    available: stock === null || stock > 0,
    images: variant?.images || [],
  };
}

module.exports = { resolveProductConfiguration };
