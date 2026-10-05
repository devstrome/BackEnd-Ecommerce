const Announcement = require('../models/Announcement');

// Public — random active announcement for the top bar
const getRandomAnnouncement = async (req, res) => {
  try {
    const announcements = await Announcement.find({ active: true }).lean();
    if (!announcements.length) return res.status(200).json({});
    const announcement = announcements[Math.floor(Math.random() * announcements.length)];
    res.status(200).json(announcement);
  } catch (error) {
    res.status(200).json({});
  }
};

// Admin
const getAllAnnouncements = async (req, res) => {
  try {
    const announcements = await Announcement.find().sort({ createdAt: -1 });
    res.status(200).json(announcements);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching announcements', error: error.message });
  }
};

const createAnnouncement = async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'Announcement text is required' });
    }
    const announcement = await Announcement.create({
      text,
      link: req.body.link || '',
      active: req.body.active !== false
    });
    res.status(201).json({ message: 'Announcement created successfully', announcement });
  } catch (error) {
    res.status(500).json({ message: 'Error creating announcement', error: error.message });
  }
};

const updateAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    res.status(200).json({ message: 'Announcement updated successfully', announcement });
  } catch (error) {
    res.status(500).json({ message: 'Error updating announcement', error: error.message });
  }
};

const deleteAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findByIdAndDelete(req.params.id);
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    res.status(200).json({ message: 'Announcement deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting announcement', error: error.message });
  }
};

module.exports = {
  getRandomAnnouncement,
  getAllAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement
};
