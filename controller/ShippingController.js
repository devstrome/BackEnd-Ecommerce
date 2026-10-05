const Shipping = require('../models/Shipping');
const { emitStoreEvent } = require('../utils/storeEvents');

exports.create = async (req, res) => {
  try {
    const shipping = await Shipping.create(req.body);
    emitStoreEvent('shipping_created', { shipping });
    res.status(201).json(shipping);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.list = async (req, res) => {
  try {
    // For public access, only return active shipping methods
    const list = await Shipping.find({ isActive: true }).sort({ charge: 1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.listAll = async (req, res) => {
  try {
    // For admin access, return all shipping methods
    const list = await Shipping.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.get = async (req, res) => {
  try {
    const item = await Shipping.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const item = await Shipping.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!item) return res.status(404).json({ message: 'Not found' });
    emitStoreEvent('shipping_updated', { shipping: item });
    res.json(item);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    await Shipping.findByIdAndDelete(req.params.id);
    emitStoreEvent('shipping_deleted', { shippingId: req.params.id });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


