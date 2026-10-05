const express = require('express');
const router = express.Router();
const HeroSlide = require('../controller/HeroSlideController');
const { authenticateAdmin, requireSuperAdmin } = require('../middleware/AdminAuthMiddleware');

// Public — storefront hero
router.get('/hero-slides', HeroSlide.getPublicHeroSlides);

// Admin — management
router.get('/admin/hero-slides', authenticateAdmin, HeroSlide.getAllHeroSlides);
router.post('/admin/hero-slides', authenticateAdmin, HeroSlide.createHeroSlide);
router.put('/admin/hero-slides-reorder', authenticateAdmin, HeroSlide.reorderHeroSlides);
router.put('/admin/hero-slides/:id/toggle', authenticateAdmin, HeroSlide.toggleHeroSlide);
router.put('/admin/hero-slides/:id', authenticateAdmin, HeroSlide.updateHeroSlide);
router.delete('/admin/hero-slides/:id', authenticateAdmin, requireSuperAdmin, HeroSlide.deleteHeroSlide);

module.exports = router;
