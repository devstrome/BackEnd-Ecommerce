const mongoose = require("mongoose");

const deliverySettingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "delivery", unique: true },
    phone: { type: String, default: "" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("DeliverySetting", deliverySettingSchema);
