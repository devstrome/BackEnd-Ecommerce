const HeroSlide = require('../models/HeroSlide');

// Public — active slides for the storefront hero
const getPublicHeroSlides = async (req, res) => {
  try {
    const slides = await HeroSlide.find({ isActive: true }).sort({ order: 1, createdAt: -1 });
    res.status(200).json(slides);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching hero slides', error: error.message });
  }
};

// Admin — all slides (including inactive)
const getAllHeroSlides = async (req, res) => {
  try {
    const slides = await HeroSlide.find().sort({ order: 1, createdAt: -1 });
    res.status(200).json(slides);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching hero slides', error: error.message });
  }
};

const createHeroSlide = async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Title is required' });
    }
    const slide = await HeroSlide.create(req.body);
    res.status(201).json({ message: 'Hero slide created successfully', slide });
  } catch (error) {
    res.status(500).json({ message: 'Error creating hero slide', error: error.message });
  }
};

const updateHeroSlide = async (req, res) => {
  try {
    const slide = await HeroSlide.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });
    if (!slide) return res.status(404).json({ message: 'Hero slide not found' });
    res.status(200).json({ message: 'Hero slide updated successfully', slide });
  } catch (error) {
    res.status(500).json({ message: 'Error updating hero slide', error: error.message });
  }
};

const deleteHeroSlide = async (req, res) => {
  try {
    const slide = await HeroSlide.findByIdAndDelete(req.params.id);
    if (!slide) return res.status(404).json({ message: 'Hero slide not found' });
    res.status(200).json({ message: 'Hero slide deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting hero slide', error: error.message });
  }
};

const toggleHeroSlide = async (req, res) => {
  try {
    const slide = await HeroSlide.findById(req.params.id);
    if (!slide) return res.status(404).json({ message: 'Hero slide not found' });
    slide.isActive = !slide.isActive;
    await slide.save();
    res.status(200).json({ message: 'Hero slide updated successfully', slide });
  } catch (error) {
    res.status(500).json({ message: 'Error toggling hero slide', error: error.message });
  }
};

const reorderHeroSlides = async (req, res) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ message: 'orderedIds must be an array' });
    }
    await Promise.all(
      orderedIds.map((id, index) =>
        HeroSlide.findByIdAndUpdate(id, { order: index }, { new: true })
      )
    );
    res.status(200).json({ message: 'Hero slides reordered successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error reordering hero slides', error: error.message });
  }
};

module.exports = {
  getPublicHeroSlides,
  getAllHeroSlides,
  createHeroSlide,
  updateHeroSlide,
  deleteHeroSlide,
  toggleHeroSlide,
  reorderHeroSlides
};
