const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');
const seoService = require('../utils/seoService');
const Product = require('../models/Product');

// Get SEO stats (products + blogs + static pages)
router.get('/seo/stats', authenticateAdmin, async (req, res) => {
  try {
    const stats = await seoService.getSEOStats();
    try {
      const Blog = require('../models/Blog');
      const StaticPage = require('../models/StaticPage');
      const [blogTotal, blogWithSEO, staticTotal, staticWithSEO] = await Promise.all([
        Blog.countDocuments(),
        Blog.countDocuments({ 'seo.metaTitle': { $ne: '' } }),
        StaticPage.countDocuments(),
        StaticPage.countDocuments({ 'seo.metaTitle': { $ne: '' } }),
      ]);
      stats.blogTotal = blogTotal;
      stats.blogWithSEO = blogWithSEO;
      stats.blogPending = blogTotal - blogWithSEO;
      stats.staticTotal = staticTotal;
      stats.staticWithSEO = staticWithSEO;
      stats.staticPending = staticTotal - staticWithSEO;
    } catch (subErr) {
      stats.blogTotal = stats.blogTotal || 0;
      stats.staticTotal = stats.staticTotal || 0;
    }
    res.json(stats);
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// Generate SEO for all pending products
router.post('/seo/generate', authenticateAdmin, async (req, res) => {
  try {
    const count = await seoService.generateSEOAll(10);
    res.json({ message: `Generated SEO for ${count} products`, count });
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// Force-regenerate SEO for ALL products
router.post('/seo/force', authenticateAdmin, async (req, res) => {
  try {
    const count = await seoService.forceRegenerateAll();
    res.json({ message: `Force-regenerated SEO for ${count} products`, count });
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// Generate SEO for a single product by ID
router.post('/seo/product/:id', authenticateAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const seo = await seoService.generateSEO(product);
    res.json({ message: 'SEO regenerated', seo });
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// Preview SEO for a product ID
router.get('/seo/product/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).select('name seo').lean();
    if (!product) return res.status(404).json({ message: 'Not found' });
    // Generate on-the-fly if missing
    if (!product.seo?.metaTitle) {
      const seo = await seoService.generateSEO(product);
      product.seo = seo;
    }
    res.json(product.seo);
  } catch (err) {
    res.status(500).json({ message: 'Failed' });
  }
});

// ─── Static pages SEO ───────────────────────────────────────
const StaticPage = require('../models/StaticPage');

const DEFAULT_STATIC_PAGES = [
  { slug: 'home', title: 'Home' },
  { slug: 'products', title: 'Products' },
  { slug: 'blog', title: 'Blog' },
  { slug: 'about', title: 'About Us' },
  { slug: 'contact', title: 'Contact Us' },
  { slug: 'wishlist', title: 'Wishlist' },
  { slug: 'cart', title: 'Cart' },
  { slug: 'checkout', title: 'Checkout' },
];

const seedStaticPages = async () => {
  try {
    const count = await StaticPage.estimatedDocumentCount();
    if (count > 0) return;
    await StaticPage.insertMany(DEFAULT_STATIC_PAGES.map((p) => ({ ...p, seo: {} })));
  } catch (err) {
    console.error('Failed to seed static pages:', err.message);
  }
};

// List static pages (admin)
router.get('/seo/static-pages', authenticateAdmin, async (req, res) => {
  try {
    await seedStaticPages();
    const pages = await StaticPage.find().sort({ slug: 1 });
    res.json(pages);
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// Update static page SEO (admin)
router.put('/seo/static-page/:slug', authenticateAdmin, async (req, res) => {
  try {
    await seedStaticPages();
    const page = await StaticPage.findOneAndUpdate(
      { slug: req.params.slug },
      { $set: { seo: req.body.seo || {} } },
      { new: true, upsert: true }
    );
    res.json({ message: 'Static page SEO updated', page });
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// ─── Product SEO manual save ────────────────────────────────
router.put('/seo/product/:id', authenticateAdmin, async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: { seo: req.body.seo || {} } },
      { new: true }
    );
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'SEO saved', seo: product.seo });
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// ─── Variant SEO (per-variant meta) ─────────────────────────
// Regenerate SEO for a single product variant
router.post('/seo/product/:id/variant/:variantId', authenticateAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const seo = await seoService.generateVariantSEO(product, req.params.variantId, { force: true });
    if (!seo) return res.status(404).json({ message: 'Variant not found' });
    res.json({ message: 'Variant SEO regenerated', seo });
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// Preview SEO for a single product variant (generates on-the-fly if missing)
router.get('/seo/product/:id/variant/:variantId', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Not found' });
    const variant = (product.variants || []).find(v => String(v._id) === String(req.params.variantId));
    if (!variant) return res.status(404).json({ message: 'Variant not found' });
    let seo = variant.seo;
    if (!seo?.metaTitle) {
      seo = await seoService.generateVariantSEO(product, req.params.variantId);
    }
    res.json(seo || {});
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// Save manual SEO edits for a single product variant
router.put('/seo/product/:id/variant/:variantId', authenticateAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const variant = (product.variants || []).find(v => String(v._id) === String(req.params.variantId));
    if (!variant) return res.status(404).json({ message: 'Variant not found' });
    variant.seo = req.body.seo || {};
    await product.save();
    res.json({ message: 'Variant SEO saved', seo: variant.seo });
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// Clear custom SEO for a single product variant (page falls back to product SEO)
router.delete('/seo/product/:id/variant/:variantId', authenticateAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const variant = (product.variants || []).find(v => String(v._id) === String(req.params.variantId));
    if (!variant) return res.status(404).json({ message: 'Variant not found' });
    variant.set('seo', undefined);
    await product.save();
    res.json({ message: 'Variant SEO cleared' });
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// ─── Blog SEO ───────────────────────────────────────────────
const Blog = require('../models/Blog');

const buildBlogSEO = (blog) => {
  const siteName = 'Belorella';
  const metaTitle = (blog.title || '').slice(0, 60) + ` | ${siteName} Blog`;
  const base = (blog.excerpt || blog.content || '').replace(/<[^>]+>/g, ' ').trim();
  const metaDescription = (base || `Read "${blog.title}" on the ${siteName} blog.`).replace(/\s+/g, ' ').trim().slice(0, 160);
  const keywords = [...new Set([blog.title, blog.category, ...(blog.tags || []), siteName, 'blog'].filter(Boolean))].join(', ');
  return {
    metaTitle,
    metaDescription,
    metaKeywords: keywords,
    ogImage: blog.seo?.ogImage || blog.coverImage || '',
    autoGenerated: true,
    lastGenerated: new Date(),
  };
};

// Regenerate SEO for a single blog post
router.post('/seo/blog/:id', authenticateAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ message: 'Blog not found' });
    blog.seo = buildBlogSEO(blog);
    await blog.save();
    res.json({ message: 'SEO regenerated', seo: blog.seo });
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

// Save manual SEO edits for a blog post
router.put('/seo/blog/:id', authenticateAdmin, async (req, res) => {
  try {
    const blog = await Blog.findByIdAndUpdate(
      req.params.id,
      { $set: { seo: req.body.seo || {} } },
      { new: true }
    );
    if (!blog) return res.status(404).json({ message: 'Blog not found' });
    res.json({ message: 'SEO saved', seo: blog.seo });
  } catch (err) {
    res.status(500).json({ message: 'Failed', error: err.message });
  }
});

module.exports = router;
