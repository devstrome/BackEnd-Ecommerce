const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const heroSlideSchema = new Schema({
  tag: { type: String, default: '' },
  title: { type: String, required: true },
  highlight: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  cta: { type: String, default: 'Shop Now' },
  link: { type: String, default: '/products' },
  bgImage: { type: String, default: '' },
  textColor: { type: String, default: '#1A1A1A' },
  highlightColor: { type: String, default: '#DC143C' },
  bgGradient: { type: String, default: 'from-maybelline-light via-pure-white to-maybelline-rose/10' },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('HeroSlide', heroSlideSchema, 'heroslides');
