const mongoose = require('mongoose');
const { Schema } = mongoose;

// A banned identity blocks both login AND new account creation from the same
// device/network. Matching is any-of: IP, manual device ID, or browser
// fingerprint (user-agent + screen quirks sent by the client).
const banSchema = new Schema(
  {
    // What we matched on at ban time — stored so we can show admins WHY
    ip: { type: String, trim: true },
    deviceId: { type: String, trim: true }, // client-generated device id from localStorage
    fingerprint: { type: String, trim: true }, // UA + screen signature hash
    network: { type: String, trim: true }, // e.g. the IP's /24 network or ASN-ish label

    targetType: { type: String, enum: ['user', 'admin'], required: true },
    targetId: { type: Schema.Types.ObjectId, refPath: 'targetType' }, // the user/admin doc
    targetEmail: { type: String, trim: true, lowercase: true },

    reason: { type: String, default: '' },
    bannedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

banSchema.index({ ip: 1 });
banSchema.index({ deviceId: 1 });
banSchema.index({ fingerprint: 1 });
banSchema.index({ active: 1 });

module.exports = mongoose.model('Ban', banSchema);
