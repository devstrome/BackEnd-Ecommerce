const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { getDashboardStats, getRealTimeUpdates, getChartData } = require('../controller/DashboardController');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

// Dashboard statistics routes (admin only)
router.get('/stats', authenticateAdmin, getDashboardStats);
router.get('/realtime', authenticateAdmin, getRealTimeUpdates);
router.get('/charts', authenticateAdmin, getChartData);

// Live product viewers (admin only) — reads the in-memory tracker from index.js
router.get('/viewers', authenticateAdmin, async (req, res) => {
  try {
    const map = req.app.get('productViewers');
    const counts = new Map();
    const sockets = new Set();
    if (map && typeof map.entries === 'function') {
      for (const [pid, set] of map.entries()) {
        if (set && set.size > 0) {
          counts.set(String(pid), set.size);
          set.forEach((sid) => sockets.add(sid));
        }
      }
    }

    let productsBeingViewed = [];
    const ids = [...counts.keys()].filter((id) => mongoose.isValidObjectId(id));
    if (ids.length > 0) {
      const Product = require('../models/Product');
      const docs = await Product.find({ _id: { $in: ids } }).select('name mainImage').lean();
      productsBeingViewed = docs
        .map((d) => ({
          _id: d._id,
          name: d.name,
          mainImage: d.mainImage,
          viewerCount: counts.get(String(d._id)) || 0,
        }))
        .sort((a, b) => b.viewerCount - a.viewerCount);
    }

    res.json({
      viewerStats: {
        totalViewers: sockets.size,
        productsBeingViewed,
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load viewer stats', error: err.message });
  }
});

module.exports = router;
