require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product');

const shouldApply = process.argv.includes('--apply');

function optionsFor(variant, product) {
  if (Array.isArray(variant.options) && variant.options.length) return variant.options;
  return (variant.sizes || []).map((size, index) => ({
    size: String(size || '').trim(),
    measureType: variant.measureType || product.measureType || '',
    unitName: variant.unitName || product.unitName || '',
    price: Number(variant.prices?.[index]),
    discountPrice: Number(variant.discountPrices?.[index]) || 0,
    stock: Number(variant.stockBySize?.[index] ?? 0),
    badgeName: variant.badgeNames?.[index] || '',
    badgeColor: variant.badgeColors?.[index] || '',
  }));
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  const products = await Product.find({ 'variants.0': { $exists: true } });
  let updated = 0;
  let skipped = 0;

  for (const product of products) {
    let changed = false;
    const productRegionIds = new Set((product.regions || []).map(String));
    if (product.regionId) productRegionIds.add(String(product.regionId));
    for (const variant of product.variants) {
      if (!variant.regionId && productRegionIds.size === 1) {
        variant.regionId = [...productRegionIds][0];
        changed = true;
      }
      const options = optionsFor(variant, product);
      if (!options.length || options.some((option) => !Number.isFinite(option.price) || option.price <= 0)) {
        skipped++;
        continue;
      }
      if (!variant.options?.length) {
        variant.options = options;
        changed = true;
      }
    }

    if (changed) {
      updated++;
      if (shouldApply) await product.save();
    }
  }

  console.log(JSON.stringify({ mode: shouldApply ? 'apply' : 'dry-run', scanned: products.length, productsToUpdate: updated, unconfiguredVariants: skipped }, null, 2));
  if (!shouldApply) console.log('Run with --apply to write this additive migration. Legacy fields remain intact.');
}

main()
  .catch((error) => { console.error('Product configuration migration failed:', error.message); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect().catch(() => {}); });
