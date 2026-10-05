const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const subscriberSchema = new Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/\S+@\S+\.\S+/, 'Please enter a valid email address']
  },
  name: { type: String, default: '' },
  source: { type: String, default: 'home' },
  subscribed: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Subscriber', subscriberSchema, 'subscribers');
