const Subscriber = require('../models/Subscriber');
const User = require('../models/User');

// Public — newsletter signup
const subscribe = async (req, res) => {
  try {
    const { email, source } = req.body;
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }

    const existing = await Subscriber.findOne({ email: email.toLowerCase() });
    if (existing) {
      if (!existing.subscribed) {
        existing.subscribed = true;
        existing.source = source || existing.source;
        await existing.save();
      }
      return res.status(200).json({ message: 'You are already subscribed. Welcome back!' });
    }

    await Subscriber.create({
      email,
      source: source || 'home',
      subscribed: true
    });
    res.status(201).json({ message: 'Subscribed successfully! Thank you for joining us.' });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(200).json({ message: 'You are already subscribed. Welcome back!' });
    }
    res.status(500).json({ message: 'Something went wrong. Please try again.', error: error.message });
  }
};

// Admin — paginated list
const listSubscribers = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 20, 1);
    const search = (req.query.search || '').trim();

    const filter = search
      ? { email: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
      : {};

    const [total, subscribers] = await Promise.all([
      Subscriber.countDocuments(filter),
      Subscriber.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
    ]);

    res.status(200).json({
      subscribers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching subscribers', error: error.message });
  }
};

// Admin — newsletter audience stats
const getSubscriberStats = async (req, res) => {
  try {
    const [totalSubscribed, registeredSubscribed, totalUnsubscribed] = await Promise.all([
      Subscriber.countDocuments({ subscribed: true }),
      Subscriber.countDocuments({ subscribed: true, source: 'registered' }),
      Subscriber.countDocuments({ subscribed: false })
    ]);

    res.status(200).json({
      totalSubscribed,
      registeredSubscribed,
      emailSubscribed: Math.max(totalSubscribed - registeredSubscribed, 0),
      totalUnsubscribed
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching subscriber stats', error: error.message });
  }
};

const deleteSubscriber = async (req, res) => {
  try {
    const subscriber = await Subscriber.findByIdAndDelete(req.params.id);
    if (!subscriber) return res.status(404).json({ message: 'Subscriber not found' });
    res.status(200).json({ message: 'Subscriber deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting subscriber', error: error.message });
  }
};

// Admin — add every registered user to the newsletter audience
const subscribeAllUsers = async (req, res) => {
  try {
    const users = await User.find({ email: { $exists: true, $ne: null } })
      .select('email firstName lastName')
      .lean();

    let added = 0;
    for (const user of users) {
      if (!user.email) continue;
      const result = await Subscriber.updateOne(
        { email: user.email.toLowerCase() },
        {
          $setOnInsert: {
            email: user.email.toLowerCase(),
            name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
            source: 'registered',
            subscribed: true
          }
        },
        { upsert: true }
      );
      if (result.upsertedCount) added += 1;
    }

    res.status(200).json({
      message: `${added} registered user${added === 1 ? '' : 's'} added to the newsletter list.`
    });
  } catch (error) {
    res.status(500).json({ message: 'Error subscribing registered users', error: error.message });
  }
};

module.exports = {
  subscribe,
  listSubscribers,
  getSubscriberStats,
  deleteSubscriber,
  subscribeAllUsers
};
