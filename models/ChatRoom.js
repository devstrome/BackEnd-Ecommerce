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
    enum: ['customer', 'admin'],
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
    senderType: { type: String, enum: ['customer', 'admin'], default: 'customer' },
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
  senderName: {
    type: String,
    default: ""
  },
  readBy: [{
    readerType: {
      type: String,
      enum: ['customer', 'admin'],
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
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  assignedAdmin: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  isClosed: { type: Boolean, default: false },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  closedAt: { type: Date },
  messages: [MessageSchema],
}, { timestamps: true });

module.exports = mongoose.model("ChatRoom", ChatRoomSchema);
