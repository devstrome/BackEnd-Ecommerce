const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { sanitizeRichHtml } = require('../utils/sanitizeHtml');

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
}, {
  timestamps: true,
  toJSON: {
    transform(_doc, ret) {
      ret.content = sanitizeRichHtml(ret.content || '');
      return ret;
    },
  },
});

helpPageSchema.pre('validate', function sanitizeHelpContent(next) {
  this.content = sanitizeRichHtml(this.content || '');
  next();
});

module.exports = mongoose.model('HelpPage', helpPageSchema, 'help-pages');
