const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const helpPageSchema = new Schema({
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  title: { type: String, required: true, trim: true },
  icon: { type: String, default: '' },
  content: { type: String, default: '' },
  order: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  seo: {
    metaTitle: { type: String, default: '' },
    metaDescription: { type: String, default: '' },
    metaKeywords: { type: String, default: '' },
    ogImage: { type: String, default: '' },
  },
}, { timestamps: true });

module.exports = mongoose.model('HelpPage', helpPageSchema, 'help-pages');
