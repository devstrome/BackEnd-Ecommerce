const mongoose = require('mongoose');
const Product = require('../models/Product');
const Region = require('../models/Region');

const BRAND = 'BELORELLA';
const MAX_TITLE_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 160;

const referenceId = (value) => String(value?._id || value || '');

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function fitText(value, limit) {
  const text = cleanText(value);
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace >= Math.floor(limit * 0.6) ? cut.slice(0, lastSpace) : cut.slice(0, limit)).trim();
}

function uniqueText(values, limit = Infinity) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = cleanText(value);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function getVariantOptions(variant = {}) {
  if (Array.isArray(variant.options) && variant.options.length) return variant.options;
  const sizes = Array.isArray(variant.sizes) ? variant.sizes : [];
  return sizes.map((size, index) => ({
    size,
    measureType: variant.measureType || '',
    unitName: variant.unitName || '',
    price: variant.prices?.[index],
    discountPrice: variant.discountPrices?.[index],
  }));
}

function getOptionLabels(variant = {}) {
  return uniqueText(getVariantOptions(variant).map((option) => {
    const size = cleanText(option.size);
    if (size) return size;
    return [option.measureType, option.unitName].map(cleanText).filter(Boolean).join(' ');
  }));
}

async function withRegionNames(product) {
  if (!product) return product;
  const source = typeof product.toObject === 'function' ? product.toObject() : product;
  const variants = Array.isArray(source.variants) ? source.variants : [];
  const refs = [source.regionId, ...(Array.isArray(source.regions) ? source.regions : []), ...variants.map((variant) => variant.regionId)].filter(Boolean);
  const names = new Map();
  const unresolvedIds = [];

  for (const ref of refs) {
    const id = referenceId(ref);
    const name = typeof ref === 'object' ? (ref.name || ref.slug) : '';
    if (id && name) names.set(id, cleanText(name));
    else if (id && mongoose.isValidObjectId(id)) unresolvedIds.push(id);
  }

  if (unresolvedIds.length) {
    try {
      const regions = await Region.find({ _id: { $in: [...new Set(unresolvedIds)] } }).select('name slug').lean();
      regions.forEach((region) => names.set(String(region._id), cleanText(region.name || region.slug)));
    } catch (error) {
      console.error('Could not resolve SEO region names:', error.message);
    }
  }

  const nameFor = (ref) => names.get(referenceId(ref)) || (typeof ref === 'object' ? cleanText(ref.name || ref.slug) : '');
  const regionName = nameFor(source.regionId) || cleanText(source.regionName);
  const variantRegionNames = variants.map((variant) =>
    nameFor(variant.regionId) || cleanText(variant.regionName)
  );
  const regionNames = uniqueText([
    ...(Array.isArray(source.regions) ? source.regions.map(nameFor) : []),
    regionName,
    ...variantRegionNames,
  ]);

  return {
    ...source,
    regionName,
    regionNames,
    variants: variants.map((variant) => ({
      ...variant,
      regionName: nameFor(variant.regionId) || cleanText(variant.regionName) || regionNames.join(', '),
    })),
  };
}

function productDisplayName(product) {
  const name = cleanText(product.name);
  const brand = cleanText(product.brand);
  return brand && !name.toLocaleLowerCase().includes(brand.toLocaleLowerCase())
    ? brand + ' ' + name
    : name;
}

function makeMetaTitle(product, variant = null) {
  const parts = [productDisplayName(product)];
  if (variant?.colorName) parts.push(cleanText(variant.colorName));
  const region = cleanText(variant?.regionName || product.regionName);
  if (region) parts.push(region);
  const suffix = ' | ' + BRAND;
  return fitText(parts.filter(Boolean).join(' — '), MAX_TITLE_LENGTH - suffix.length) + suffix;
}

function makeMetaDescription(product, variant = null) {
  const name = productDisplayName(product) || 'Product';
  const description = cleanText(variant?.description || product.description);
  const base = description
    ? (description.toLocaleLowerCase().includes(name.toLocaleLowerCase()) ? description : name + '. ' + description)
    : 'Shop ' + name + ' at ' + BRAND + '.';
  const details = [];

  if (variant?.colorName) details.push('Color: ' + cleanText(variant.colorName) + '.');
  const options = variant ? getOptionLabels(variant) : [];
  if (options.length) details.push('Options: ' + options.slice(0, 4).join(', ') + '.');
  const categories = Array.isArray(product.categories) ? uniqueText(product.categories.flat(Infinity), 3) : [];
  if (categories.length) details.push('Category: ' + categories.join(' > ') + '.');
  const regions = variant?.regionName
    ? [cleanText(variant.regionName)]
    : uniqueText(product.regionNames || [product.regionName], 4);
  if (regions.length) details.push('Available in ' + regions.join(', ') + '.');
  if (!base.toLocaleLowerCase().includes(BRAND.toLocaleLowerCase())) details.push('Shop ' + BRAND + ' Bangladesh.');

  return fitText([base, ...details].join(' '), MAX_DESCRIPTION_LENGTH);
}

function makeKeywords(product, variant = null) {
  const categories = Array.isArray(product.categories) ? product.categories.flat(Infinity) : [];
  const variantRegions = Array.isArray(product.variants) ? product.variants.map((item) => item.regionName) : [];
  const regions = variant?.regionName ? [variant.regionName] : [...(product.regionNames || []), ...variantRegions];
  const variantTerms = variant
    ? [variant.colorName, ...getOptionLabels(variant)]
    : (Array.isArray(product.variants) ? product.variants.flatMap((item) => [item.colorName, ...getOptionLabels(item)]) : []);
  return uniqueText([
    product.name,
    product.brand,
    ...categories,
    ...variantTerms,
    ...regions,
    product.gender,
    BRAND,
    'Bangladesh',
  ], 16).join(', ');
}

function makeSEO(product, variant = null) {
  return {
    metaTitle: makeMetaTitle(product, variant),
    metaDescription: makeMetaDescription(product, variant),
    metaKeywords: makeKeywords(product, variant),
    ogImage: variant?.images?.[0] || product.mainImage || product.variants?.find((item) => item.images?.[0])?.images?.[0] || '',
    autoGenerated: true,
    lastGenerated: new Date(),
  };
}

function buildSEO(product) {
  if (!product) return null;
  return makeSEO(product);
}

function buildVariantSEO(product, variant) {
  if (!product || !variant) return null;
  return makeSEO(product, variant);
}

async function generateSEO(product, { force = true } = {}) {
  if (!product || !product._id) return null;
  product = await withRegionNames(product);

  if (!force && product.seo?.autoGenerated === false) {
    await generateVariantSEO(product, null, { force: false });
    return product.seo;
  }

  const seo = buildSEO(product);
  await Product.updateOne({ _id: product._id }, { $set: { seo } });
  await generateVariantSEO(product, null, { force: false });
  return seo;
}

async function generateVariantSEO(product, onlyVariantId = null, { force = false } = {}) {
  if (!product || !product._id || !Array.isArray(product.variants) || product.variants.length === 0) return null;
  product = await withRegionNames(product);

  const targets = product.variants
    .map((variant, index) => ({ variant, index }))
    .filter(({ variant }) => !onlyVariantId || String(variant._id) === String(onlyVariantId))
    .filter(({ variant }) => force || variant.seo?.autoGenerated !== false);

  if (!targets.length) return null;

  const saved = [];
  for (const { variant, index } of targets) {
    const seo = buildVariantSEO(product, variant);
    await Product.updateOne({ _id: product._id }, { $set: { ['variants.' + index + '.seo']: seo } });
    saved.push(seo);
  }

  return onlyVariantId ? saved[0] || null : saved;
}

async function generateSEOAll(batchSize = 10) {
  const cursor = Product.find({
    $or: [
      { 'seo.metaTitle': { $exists: false } },
      { 'seo.metaTitle': '' },
    ],
  }).cursor();

  let count = 0;
  let batch = [];
  for await (const product of cursor) {
    batch.push(product);
    if (batch.length >= batchSize) {
      const results = await Promise.all(batch.map((item) => generateSEO(item, { force: false })));
      count += results.filter(Boolean).length;
      batch = [];
    }
  }

  if (batch.length) {
    const results = await Promise.all(batch.map((item) => generateSEO(item, { force: false })));
    count += results.filter(Boolean).length;
  }
  return count;
}

async function getSEOStats() {
  const [total, withSEO] = await Promise.all([
    Product.countDocuments(),
    Product.countDocuments({ 'seo.metaTitle': { $exists: true, $ne: '' } }),
  ]);
  return { total, withSEO, pending: total - withSEO };
}

module.exports = {
  buildSEO,
  buildVariantSEO,
  generateSEO,
  generateVariantSEO,
  generateSEOAll,
  getSEOStats,
};
