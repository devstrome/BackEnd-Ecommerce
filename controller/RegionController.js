const Region = require('../models/Region');
const Product = require('../models/Product');
const mongoose = require('mongoose');
const escapeRegex = require('../utils/escapeRegex');

const slugFor = (value) => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

exports.listRegions = async (req, res) => {
  try {
    const query = {};
    if (req.query.activeOnly === 'true') query.isActive = true;
    if (req.query.search) query.name = { $regex: escapeRegex(String(req.query.search).trim().slice(0, 100)), $options: 'i' };
    const regions = await Region.find(query).sort({ name: 1 }).lean();
    return res.status(200).json(regions);
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load regions', error: error.message });
  }
};

exports.createRegion = async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Region name is required' });
    const slug = slugFor(req.body.slug || name);
    if (!slug) return res.status(400).json({ message: 'Region slug is invalid' });
    const region = await Region.create({ name, slug, description: req.body.description || '', isActive: req.body.isActive !== false });
    return res.status(201).json(region);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'A region with this name or slug already exists' });
    return res.status(500).json({ message: 'Unable to create region', error: error.message });
  }
};

exports.updateRegion = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid region ID' });
    const update = {};
    if (req.body.name !== undefined) {
      update.name = String(req.body.name).trim();
      if (!update.name) return res.status(400).json({ message: 'Region name cannot be empty' });
    }
    if (req.body.slug !== undefined || update.name) update.slug = slugFor(req.body.slug || update.name);
    if (req.body.description !== undefined) update.description = String(req.body.description).trim();
    if (req.body.isActive !== undefined) {
      if (typeof req.body.isActive !== 'boolean') return res.status(400).json({ message: 'isActive must be a boolean' });
      update.isActive = req.body.isActive;
    }
    const region = await Region.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!region) return res.status(404).json({ message: 'Region not found' });
    return res.status(200).json(region);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'A region with this name or slug already exists' });
    return res.status(500).json({ message: 'Unable to update region', error: error.message });
  }
};

exports.deleteRegion = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid region ID' });
    const region = await Region.findById(req.params.id);
    if (!region) return res.status(404).json({ message: 'Region not found' });
    const inUse = await Product.exists({ $or: [{ regions: region._id }, { 'variants.regionId': region._id }] });
    if (inUse) return res.status(409).json({ message: 'This region is assigned to products. Deactivate it or remove those assignments first.' });
    await region.deleteOne();
    return res.status(200).json({ message: 'Region deleted' });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to delete region', error: error.message });
  }
};
