// models/ChatRoom.js
const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
  _id: {
    type: mongoose.Schema.Types.ObjectId,
    default: () => new mongoose.Types.ObjectId(),
    auto: true
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'senderType'
  },
  senderType: {
    type: String,
    enum: ['customer', 'admin', 'guest'],
    required: true
  },
  text: {
    type: String,
    default: ""
  },
  image: {
    type: String,
    default: ""
  },
  reaction: {
    type: String,
    default: ""
  },
  reactions: [{
    _id: false,
    emoji: { type: String, required: true },
    userId: { type: String, required: true },
    senderType: { type: String, enum: ['customer', 'admin', 'guest'], default: 'customer' },
    userName: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now }
  }],
  edited: {
    type: Boolean,
    default: false
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  guestId: {
    type: String,
    default: ""
  },
  // Client generated id makes socket retries idempotent across transient disconnects.
  clientMessageId: {
    type: String,
    default: "",
    maxlength: 128
  },
  senderName: {
    type: String,
    default: ""
  },
  readBy: [{
    readerType: {
      type: String,
      enum: ['customer', 'admin', 'guest'],
      required: true
    },
    readerId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },
    readAt: {
      type: Date,
      default: Date.now
    }
  }],
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const ChatRoomSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  guestObjectId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  guestId: { type: String, default: '', index: true },
  guestName: { type: String, trim: true, maxlength: 100, default: '' },
  guestEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: '' },
  guestPhone: { type: String, trim: true, maxlength: 40, default: '' },
  assignedAdmin: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  isClosed: { type: Boolean, default: false },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  closedAt: { type: Date },
  messages: [MessageSchema],
}, { timestamps: true });

module.exports = mongoose.model("ChatRoom", ChatRoomSchema);
