const Category = require('../models/Categories');

const slugify = (name) =>
  String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const addCategory = async (req, res) => {
  try {
    const name = req.body.name?.trim();
    if (!name) return res.status(400).json({ message: 'Category name is required' });

    const exists = await Category.findOne({ name });
    if (exists) return res.status(409).json({ message: 'Category already exists' });

    const newCategory = await Category.create({
      name,
      slug: req.body.slug || slugify(name),
      parent: req.body.parent || null,
      image: req.body.image || '',
      description: req.body.description || '',
      isActive: req.body.isActive !== false,
      order: req.body.order || 0,
      brands: Array.isArray(req.body.brands) ? req.body.brands : []
    });
    res.status(201).json(newCategory);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getCategories = async (req, res) => {
  try {
    const categories = await Category.find().sort({ order: 1, name: 1 });
    res.status(200).json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Public — nested tree for the mega menu and home page
const getCategoriesTree = async (req, res) => {
  try {
    const categories = await Category.find().sort({ order: 1, name: 1 }).lean();

    const nodes = categories.map((cat) => ({
      _id: cat._id,
      name: cat.name,
      slug: cat.slug || slugify(cat.name),
      image: cat.image || '',
      description: cat.description || '',
      isActive: cat.isActive !== false,
      brands: Array.isArray(cat.brands) ? cat.brands : [],
      excludeBrands: Array.isArray(cat.excludeBrands) ? cat.excludeBrands : [],
      children: []
    }));

    const byId = new Map(nodes.map((node) => [String(node._id), node]));
    const roots = [];

    nodes.forEach((node) => {
      const raw = categories.find((c) => String(c._id) === String(node._id));
      const parentId = raw?.parent ? String(raw.parent) : null;
      const parent = parentId ? byId.get(parentId) : null;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    });

    const applyBrands = (node, inherited) => {
      const excluded = new Set(node.excludeBrands || []);
      const effective = [...new Set([...(inherited || []), ...(node.brands || [])])]
        .filter((b) => !excluded.has(b));
      node.brands = effective;
      node.children.forEach((child) => applyBrands(child, effective));
    };
    roots.forEach((root) => applyBrands(root, []));

    res.status(200).json(roots.filter((node) => node.isActive));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const name = req.body.name?.trim();
    if (!name) return res.status(400).json({ message: 'Updated category name is required' });

    const conflict = await Category.findOne({ name, _id: { $ne: id } });
    if (conflict) return res.status(409).json({ message: 'Category name already in use' });

    const update = {
      name,
      slug: req.body.slug || slugify(name)
    };
    if ('parent' in req.body) update.parent = req.body.parent || null;
    if ('image' in req.body) update.image = req.body.image || '';
    if ('description' in req.body) update.description = req.body.description || '';
    if ('isActive' in req.body) update.isActive = req.body.isActive !== false;
    if ('order' in req.body) update.order = req.body.order || 0;
    if (Array.isArray(req.body.brands)) update.brands = req.body.brands;
    if (Array.isArray(req.body.excludeBrands)) update.excludeBrands = req.body.excludeBrands;

    const updatedCategory = await Category.findByIdAndUpdate(id, update, { new: true });
    if (!updatedCategory) return res.status(404).json({ message: 'Category not found' });

    res.status(200).json(updatedCategory);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Category.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: 'Category not found' });
    res.status(200).json({ message: 'Category deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const addBrandToCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const brand = (req.body.brand || '').trim();
    if (!brand) return res.status(400).json({ message: 'Brand name is required' });

    const category = await Category.findById(id);
    if (!category) return res.status(404).json({ message: 'Category not found' });

    if (!category.brands.includes(brand)) category.brands.push(brand);
    category.excludeBrands = (category.excludeBrands || []).filter((b) => b !== brand);
    await category.save();

    res.status(200).json(category);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const removeBrandFromCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const brand = (req.body.brand || '').trim();
    if (!brand) return res.status(400).json({ message: 'Brand name is required' });

    const category = await Category.findById(id);
    if (!category) return res.status(404).json({ message: 'Category not found' });

    const hadOwn = category.brands.includes(brand);
    category.brands = category.brands.filter((b) => b !== brand);
    if (!hadOwn) {
      const excludes = category.excludeBrands || [];
      if (!excludes.includes(brand)) excludes.push(brand);
      category.excludeBrands = excludes;
    }
    await category.save();

    res.status(200).json(category);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  addCategory,
  getCategories,
  getCategoriesTree,
  updateCategory,
  deleteCategory,
  addBrandToCategory,
  removeBrandFromCategory
};
