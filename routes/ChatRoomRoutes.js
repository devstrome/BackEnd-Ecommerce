const express = require("express");
const router = express.Router();
const ChatController = require("../controller/ChatRoomController");
const { authenticateAdmin } = require("../middleware/AdminAuthMiddleware");
const authenticate = require("../middleware/UserAuthMiddleware");
const upload = require("../config/multerconfig");

// Chat image upload (authenticated customer) - CloudinaryStorage returns the URL
router.post("/user/upload/chat-image", authenticate, upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "No image file provided" });
  return res.json({ success: true, url: req.file.path });
});

// Customer Routes
router.get("/user/rooms/:customerId", authenticate, ChatController.getOrCreateRoom);

// Shared Routes
router.post("/user/rooms/:roomId/message", authenticate, ChatController.sendMessage);
router.post("/user/rooms/:roomId/messages/:messageId/reaction", authenticate, ChatController.addReaction);
router.post("/user/rooms/:roomId/read", authenticate, ChatController.markAsRead);
router.post("/user/rooms/:roomId/online", authenticate, ChatController.updateOnlineStatus);

// Admin Routes
router.post("/rooms/auto-assign", authenticateAdmin, ChatController.autoAssignAdmin);
router.post("/rooms/:roomId/transfer", authenticateAdmin, ChatController.transferAdmin);
router.post("/rooms/:roomId/close", authenticateAdmin, ChatController.closeRoom);
router.post("/rooms/:roomId/message", authenticateAdmin, ChatController.sendMessage);
router.post("/rooms/:roomId/read", authenticateAdmin, ChatController.markAsRead);
router.post("/rooms/:roomId/online", authenticateAdmin, ChatController.updateOnlineStatus);

// Get all chat rooms
router.get("/rooms", authenticateAdmin, ChatController.getAllRooms);

// Get specific chat room
router.get("/rooms/:roomId", authenticateAdmin, ChatController.getRoomById);

module.exports = router;