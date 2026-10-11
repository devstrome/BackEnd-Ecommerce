const PopupAd = require('../models/PopupAd');

const UNIT_MILLISECONDS = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
};

const getUrgentDuration = (value, unit) => {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 1 || amount > 10080 || !UNIT_MILLISECONDS[unit]) {
    const error = new Error('Urgent duration must be a positive whole number with a supported unit.');
    error.statusCode = 400;
    throw error;
  }
  return amount * UNIT_MILLISECONDS[unit];
};

async function deactivateExpiredUrgentAds() {
  await PopupAd.updateMany(
    { isUrgent: true, isActive: true, urgentExpiresAt: { $lte: new Date() } },
    { $set: { isActive: false } }
  );
}

// Keep the stored admin status current even when no one is visiting the site.
const expirySweep = setInterval(() => {
  deactivateExpiredUrgentAds().catch((error) => {
    console.error('Failed to expire urgent popup ads:', error.message);
  });
}, 30 * 1000);
expirySweep.unref?.();

exports.getAll = async (req, res) => {
  try {
    await deactivateExpiredUrgentAds();
    const ads = await PopupAd.find().sort({ createdAt: -1 });
    res.json(ads);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching popup ads', error: error.message });
  }
};

exports.getActive = async (req, res) => {
  try {
    await deactivateExpiredUrgentAds();
    const ads = await PopupAd.find({ isActive: true }).sort({ createdAt: -1 });
    res.json(ads);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching popup ads', error: error.message });
  }
};

exports.create = async (req, res) => {
  const { title, imageUrl, linkUrl } = req.body;
  if (!imageUrl) return res.status(400).json({ message: 'Image URL is required' });
  try {
    const isUrgent = parseBoolean(req.body.isUrgent);
    const durationValue = Number(req.body.urgentDurationValue || 1);
    const durationUnit = req.body.urgentDurationUnit || 'hours';
    const urgentExpiresAt = isUrgent
      ? new Date(Date.now() + getUrgentDuration(durationValue, durationUnit))
      : null;
    const ad = await PopupAd.create({
      title,
      imageUrl,
      linkUrl,
      isActive: parseBoolean(req.body.isActive, true),
      isUrgent,
      urgentDurationValue: durationValue,
      urgentDurationUnit: durationUnit,
      urgentExpiresAt,
    });
    res.status(201).json(ad);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: 'Failed to create popup ad', error: error.message });
  }
};

exports.update = async (req, res) => {
  const { id } = req.params;
  try {
    const ad = await PopupAd.findById(id);
    if (!ad) return res.status(404).json({ message: 'Popup ad not found' });

    const previousActive = ad.isActive;
    if (req.body.title !== undefined) ad.title = req.body.title;
    if (req.body.imageUrl !== undefined) ad.imageUrl = req.body.imageUrl;
    if (req.body.linkUrl !== undefined) ad.linkUrl = req.body.linkUrl;
    if (req.body.isActive !== undefined) ad.isActive = parseBoolean(req.body.isActive);

    const previousUrgent = ad.isUrgent;
    const previousValue = ad.urgentDurationValue;
    const previousUnit = ad.urgentDurationUnit;
    if (req.body.isUrgent !== undefined) ad.isUrgent = parseBoolean(req.body.isUrgent);
    if (req.body.urgentDurationValue !== undefined) ad.urgentDurationValue = Number(req.body.urgentDurationValue);
    if (req.body.urgentDurationUnit !== undefined) ad.urgentDurationUnit = req.body.urgentDurationUnit;

    if (!ad.isUrgent) {
      ad.urgentExpiresAt = null;
    } else if (
      !previousUrgent ||
      previousValue !== ad.urgentDurationValue ||
      previousUnit !== ad.urgentDurationUnit ||
      !ad.urgentExpiresAt ||
      (!previousActive && ad.isActive && ad.urgentExpiresAt <= new Date())
    ) {
      ad.urgentExpiresAt = new Date(Date.now() + getUrgentDuration(ad.urgentDurationValue, ad.urgentDurationUnit));
    }

    await ad.save();
    res.json(ad);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: 'Error updating popup ad', error: error.message });
  }
};

exports.remove = async (req, res) => {
  const { id } = req.params;
  try {
    const ad = await PopupAd.findByIdAndDelete(id);
    if (!ad) return res.status(404).json({ message: 'Popup ad not found' });
    res.json({ message: 'Popup ad deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting popup ad', error: error.message });
  }
};
