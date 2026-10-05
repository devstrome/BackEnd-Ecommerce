const HelpPage = require('../models/HelpPage');

const slugify = (name) =>
  String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const DEFAULT_PAGES = [
  { slug: 'faq', title: 'Frequently Asked Questions', icon: '❓', order: 1 },
  { slug: 'shipping-policy', title: 'Shipping Policy', icon: '🚚', order: 2 },
  { slug: 'return-policy', title: 'Return & Refund Policy', icon: '↺', order: 3 },
  { slug: 'privacy', title: 'Privacy Policy', icon: '🔒', order: 4 },
  { slug: 'terms', title: 'Terms & Conditions', icon: '📄', order: 5 },
];

const seedDefaults = async () => {
  try {
    const count = await HelpPage.estimatedDocumentCount();
    if (count > 0) return;
    await HelpPage.insertMany(DEFAULT_PAGES.map((p) => ({ ...p, active: true, content: '', seo: {} })));
  } catch (error) {
    console.error('Failed to seed help pages:', error.message);
  }
};

// Admin list
const getAdminHelpPages = async (req, res) => {
  try {
    await seedDefaults();
    const pages = await HelpPage.find().sort({ order: 1, title: 1 });
    res.status(200).json(pages);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch help pages', error: error.message });
  }
};

// Admin single (by id)
const getAdminHelpPage = async (req, res) => {
  try {
    const page = await HelpPage.findById(req.params.id);
    if (!page) return res.status(404).json({ message: 'Help page not found' });
    res.status(200).json(page);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch help page', error: error.message });
  }
};

// Admin create
const createHelpPage = async (req, res) => {
  try {
    const { title, content, icon, order, active, seo } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: 'Title is required' });

    const slug = slugify(title);
    const exists = await HelpPage.findOne({ slug });
    if (exists) return res.status(409).json({ message: 'A help page with this title already exists' });

    const page = await HelpPage.create({
      slug,
      title: title.trim(),
      icon: icon || '',
      content: content || '',
      order: Number(order) || 0,
      active: active !== false,
      seo: seo || {},
    });
    res.status(201).json(page);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create help page', error: error.message });
  }
};

// Admin update
const updateHelpPage = async (req, res) => {
  try {
    const page = await HelpPage.findById(req.params.id);
    if (!page) return res.status(404).json({ message: 'Help page not found' });

    const { title, content, icon, order, active, seo, slug } = req.body;
    if (title?.trim()) {
      const newSlug = slugify(title);
      if (newSlug !== page.slug) {
        const exists = await HelpPage.findOne({ slug: newSlug, _id: { $ne: page._id } });
        if (exists) return res.status(409).json({ message: 'A help page with this title already exists' });
        page.slug = newSlug;
      }
      page.title = title.trim();
    }
    if (content !== undefined) page.content = content;
    if (icon !== undefined) page.icon = icon;
    if (order !== undefined) page.order = Number(order) || 0;
    if (active !== undefined) page.active = active !== false;
    if (seo !== undefined) page.seo = seo;
    if (slug) page.slug = slugify(slug);

    await page.save();
    res.status(200).json(page);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update help page', error: error.message });
  }
};

// Admin delete
const deleteHelpPage = async (req, res) => {
  try {
    const deleted = await HelpPage.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Help page not found' });
    res.status(200).json({ message: 'Help page deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete help page', error: error.message });
  }
};

// Public list (active only)
const getPublicHelpPages = async (req, res) => {
  try {
    await seedDefaults();
    const pages = await HelpPage.find({ active: true }).sort({ order: 1, title: 1 });
    res.status(200).json(pages);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch help pages', error: error.message });
  }
};

// Public single (by slug)
const getPublicHelpPage = async (req, res) => {
  try {
    await seedDefaults();
    const page = await HelpPage.findOne({ slug: req.params.slug, active: true });
    if (!page) return res.status(404).json({ message: 'Page not found' });
    res.status(200).json(page);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch help page', error: error.message });
  }
};

module.exports = {
  getAdminHelpPages,
  getAdminHelpPage,
  createHelpPage,
  updateHelpPage,
  deleteHelpPage,
  getPublicHelpPages,
  getPublicHelpPage,
};
