// models/Category.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const categorySchema = new Schema({
  name: { type: String, required: true, unique: true },
  slug: { type: String, trim: true, lowercase: true, index: true },
  parent: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
  image: { type: String, default: '' },
  description: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
  brands: [{ type: String }],
  excludeBrands: [{ type: String }]
}, { timestamps: true });

const Category = mongoose.model('Category', categorySchema);

module.exports = Category;
