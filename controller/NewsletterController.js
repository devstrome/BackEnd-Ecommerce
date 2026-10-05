const Newsletter = require('../models/Newsletter');
const Subscriber = require('../models/Subscriber');
const { sendEmail } = require('../utils/emailService');

// Admin
const getAllNewsletters = async (req, res) => {
  try {
    const newsletters = await Newsletter.find().sort({ createdAt: -1 });
    res.status(200).json(newsletters);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching newsletters', error: error.message });
  }
};

const createNewsletter = async (req, res) => {
  try {
    const { subject, htmlContent } = req.body;
    if (!subject || !subject.trim()) {
      return res.status(400).json({ message: 'Subject is required' });
    }
    if (!htmlContent || !htmlContent.trim()) {
      return res.status(400).json({ message: 'Email content is required' });
    }

    const newsletter = await Newsletter.create({ subject, htmlContent });
    res.status(201).json({ message: 'Newsletter draft saved', newsletter });
  } catch (error) {
    res.status(500).json({ message: 'Error creating newsletter', error: error.message });
  }
};

const deleteNewsletter = async (req, res) => {
  try {
    const newsletter = await Newsletter.findByIdAndDelete(req.params.id);
    if (!newsletter) return res.status(404).json({ message: 'Newsletter not found' });
    res.status(200).json({ message: 'Newsletter deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting newsletter', error: error.message });
  }
};

// Admin — send a newsletter to every active subscriber
const sendNewsletter = async (req, res) => {
  try {
    const newsletter = await Newsletter.findById(req.params.id);
    if (!newsletter) return res.status(404).json({ message: 'Newsletter not found' });

    const subscribers = await Subscriber.find({ subscribed: true }).select('email').lean();
    if (!subscribers.length) {
      return res.status(400).json({ message: 'No active subscribers to send to' });
    }

    const results = await Promise.all(
      subscribers.map((subscriber) =>
        sendEmail(subscriber.email, 'custom', {
          customSubject: newsletter.subject,
          customHtml: newsletter.htmlContent
        })
      )
    );

    const sentCount = results.filter((r) => r && r.success).length;
    const failedCount = results.length - sentCount;

    newsletter.status = 'sent';
    newsletter.sentCount = sentCount;
    newsletter.failedCount = failedCount;
    newsletter.sentAt = new Date();
    await newsletter.save();

    res.status(200).json({
      message: `Newsletter sent to ${sentCount} subscriber${sentCount === 1 ? '' : 's'}${failedCount ? ` (${failedCount} failed)` : ''}.`,
      newsletter
    });
  } catch (error) {
    res.status(500).json({ message: 'Error sending newsletter', error: error.message });
  }
};

module.exports = {
  getAllNewsletters,
  createNewsletter,
  deleteNewsletter,
  sendNewsletter
};
