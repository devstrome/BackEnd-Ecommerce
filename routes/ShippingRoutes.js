const express = require('express');
const router = express.Router();
const { create, list, listAll, get, update, remove } = require('../controller/ShippingController');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');
const DeliverySetting = require('../models/DeliverySetting');

// Public list/get (only active shipping methods)
router.get('/shipping', list);
router.get('/shipping/:id', get);

// Delivery contact number (public read, admin write)
router.get('/delivery-setting', async (req, res) => {
  try {
    let doc = await DeliverySetting.findOne({ key: 'delivery' });
    if (!doc) doc = await DeliverySetting.create({ key: 'delivery', phone: '' });
    res.json({ phone: doc.phone || '' });
  } catch (err) {
    console.error('Delivery setting read error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/delivery-setting', authenticateAdmin, async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const doc = await DeliverySetting.findOneAndUpdate(
      { key: 'delivery' },
      { phone },
      { new: true, upsert: true }
    );
    res.json({ success: true, phone: doc.phone });
  } catch (err) {
    console.error('Delivery setting update error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin protected CRUD
router.get('/shipping/admin/all', authenticateAdmin, listAll);
router.post('/shipping', authenticateAdmin, create);
router.put('/shipping/:id', authenticateAdmin, update);
router.delete('/shipping/:id', authenticateAdmin, remove);

module.exports = router;


