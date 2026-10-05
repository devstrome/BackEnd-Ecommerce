const ChatRoom = require("../models/ChatRoom");
const { NotFoundError, BadRequestError } = require("../errors/errors");
const mongoose = require('mongoose');

exports.getOrCreateRoom = async (req, res) => {
  try {
    const { customerId } = req.params;
    const userId = req.user?._id;

    // Validate input
    if (!customerId || !userId) {
      throw new BadRequestError('Customer ID and User ID are required');
    }

    let room = await ChatRoom.findOne({
      customerId,
      isClosed: false
    })
    .populate('customerId', 'firstName lastName email imageUrl')
    .populate('assignedAdmin', 'firstName lastName email imageUrl');

    if (!room) {
      room = await ChatRoom.create({ 
        customerId,
        messages: []
      });
      
      // Notify admin room about new chat
      const io = req.app.get('socketio');
      if (io) {
        io.to('adminRoom').emit('newChatRoom', room);
        console.log(`📤 Emitted newChatRoom to adminRoom`);
      }
    }

    res.json(room);
  } catch (err) {
    console.error('Error in getOrCreateRoom:', err);
    res.status(err.statusCode || 500).json({ 
      message: err.message || 'Server error' 
    });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { text } = req.body;
    const senderId = req.user?._id || req.admin?._id;
    const senderType = req.user ? "customer" : "admin";

    // Validate input
    if (!roomId || !text || !senderId) {
      throw new BadRequestError('Room ID, text, and sender ID are required');
    }

    const room = await ChatRoom.findById(roomId);
    if (!room) {
      throw new NotFoundError('Chat room not found');
    }

    if (room.isClosed) {
      throw new BadRequestError('Cannot send message to closed chat room');
    }

    // Create message with proper structure and explicit _id
    const newMessage = {
      _id: new mongoose.Types.ObjectId(), // Explicitly set _id
      senderId, 
      senderType, 
      text,
      reaction: "",
      readBy: [{
        readerType: senderType,
        readerId: senderId,
        readAt: new Date()
      }],
      createdAt: new Date()
    };
    
    // Add message to room
    room.messages.push(newMessage);
    await room.save();

    // Get the saved message with proper _id
    const savedMessage = room.messages[room.messages.length - 1];

    // Emit via socket
    const io = req.app.get('socketio');
    if (io) {
      // Use toObject() to ensure proper serialization
      const messageData = { ...savedMessage.toObject(), roomId };
      io.to(`chat_${roomId}`).emit("messageReceived", messageData);
      io.to('adminRoom').emit("messageReceived", messageData);
      
      // Emit message confirmation for temporary messages
      io.to(`chat_${roomId}`).emit("messageConfirmed", {
        tempId: `temp_${Date.now()}`,
        realId: savedMessage._id,
        updates: {
          _id: savedMessage._id,
          readBy: savedMessage.readBy
        }
      });
      
      console.log(`📤 Emitted message to chat_${roomId} and adminRoom`);
    }

    res.status(201).json(savedMessage);
  } catch (err) {
    console.error('Error in sendMessage:', err);
    res.status(err.statusCode || 500).json({ 
      message: err.message || 'Server error' 
    });
  }
};

// Auto-assign admin to unassigned room
exports.autoAssignAdmin = async (req, res) => {
  try {
    const adminId = req.admin._id;
    const adminName = req.admin.firstName || req.admin.name || 'Admin';

    // Find an unassigned room
    const unassignedRoom = await ChatRoom.findOne({ 
      assignedAdmin: null, 
      isClosed: false 
    }).populate('customerId', 'firstName lastName');

    if (!unassignedRoom) {
      return res.json({ message: "No unassigned rooms available" });
    }

    // Assign admin to the room
    unassignedRoom.assignedAdmin = adminId;
    await unassignedRoom.save();

    // Send auto-welcome message with proper _id
    const welcomeMessage = {
      _id: new mongoose.Types.ObjectId(), // Explicitly set _id
      senderId: adminId,
      senderType: "admin",
      text: `Hello ${unassignedRoom.customerId.firstName || 'there'}! ${adminName} speaking, how can I help you today?`,
      reaction: "",
      readBy: [{
        readerType: "admin",
        readerId: adminId,
        readAt: new Date()
      }],
      createdAt: new Date()
    };

    // Add welcome message to room
    unassignedRoom.messages.push(welcomeMessage);
    await unassignedRoom.save();

    // Get the saved message with proper _id
    const savedWelcomeMessage = unassignedRoom.messages[unassignedRoom.messages.length - 1];

    // Emit welcome message via socket
    const io = req.app.get('socketio');
    if (io) {
      // Use toObject() to ensure proper serialization
      const messageData = { ...savedWelcomeMessage.toObject(), roomId: unassignedRoom._id };
      io.to(`chat_${unassignedRoom._id}`).emit("messageReceived", messageData);
      io.to('adminRoom').emit("messageReceived", messageData);
      io.to('adminRoom').emit("roomAssigned", { 
        roomId: unassignedRoom._id, 
        adminId,
        adminName 
      });
    }

    res.json({ 
      message: "Admin auto-assigned successfully", 
      room: unassignedRoom,
      welcomeMessage 
    });
  } catch (err) {
    console.error('Error in autoAssignAdmin:', err);
    res.status(err.statusCode || 500).json({ 
      message: err.message || 'Server error' 
    });
  }
};

exports.transferAdmin = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { newAdminId } = req.body;
    const currentAdminId = req.admin._id;

    if (!roomId || !newAdminId) {
      throw new BadRequestError('Room ID and new admin ID are required');
    }

    const room = await ChatRoom.findById(roomId);
    if (!room) {
      throw new NotFoundError('Chat room not found');
    }

    // Check if current admin is assigned to this room
    if (room.assignedAdmin && !room.assignedAdmin.equals(currentAdminId)) {
      throw new BadRequestError('Only assigned admin can transfer this room');
    }

    room.assignedAdmin = newAdminId;
    await room.save();

    // Notify via socket
    const io = req.app.get('socketio');
    if (io) {
      io.to(`chat_${roomId}`).emit("roomTransferred", { 
        roomId, 
        newAdminId,
        transferredBy: currentAdminId
      });
      io.to('adminRoom').emit("roomTransferred", { 
        roomId, 
        newAdminId,
        transferredBy: currentAdminId
      });
    }

    res.json(room);
  } catch (err) {
    console.error('Error in transferAdmin:', err);
    res.status(err.statusCode || 500).json({ 
      message: err.message || 'Server error' 
    });
  }
};

exports.closeRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const adminId = req.admin._id;

    if (!roomId) {
      throw new BadRequestError('Room ID is required');
    }

    const room = await ChatRoom.findById(roomId);
    if (!room) {
      throw new NotFoundError('Chat room not found');
    }

    // Check if admin is assigned to this room
    if (room.assignedAdmin && !room.assignedAdmin.equals(adminId)) {
      throw new BadRequestError('Only assigned admin can close this room');
    }

    room.isClosed = true;
    room.closedBy = adminId;
    room.closedAt = new Date();
    await room.save();

    // Notify via socket
    const io = req.app.get('socketio');
    if (io) {
      io.to(`chat_${roomId}`).emit("roomClosed", { 
        roomId, 
        closedBy: adminId 
      });
      io.to('adminRoom').emit("roomClosed", { 
        roomId, 
        closedBy: adminId 
      });
    }

    res.json({ 
      message: "Room closed successfully", 
      roomId,
      closedBy: adminId,
      closedAt: room.closedAt
    });
  } catch (err) {
    console.error('Error in closeRoom:', err);
    res.status(err.statusCode || 500).json({ 
      message: err.message || 'Server error' 
    });
  }
};

exports.addReaction = async (req, res) => {
  try {
    const { roomId, messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user?._id || req.admin?._id;

    if (!roomId || !messageId || !emoji) {
      throw new BadRequestError('Room ID, message ID and emoji are required');
    }

    const room = await ChatRoom.findById(roomId);
    if (!room) {
      throw new NotFoundError('Chat room not found');
    }

    const msg = room.messages.id(messageId);
    if (!msg) {
      throw new NotFoundError('Message not found');
    }

    // Toggle this user's reaction (Messenger-style: same emoji again removes it)
    if (!msg.reactions) msg.reactions = [];
    const senderType = req.admin ? 'admin' : 'customer';
    const existingIdx = msg.reactions.findIndex(r => String(r.userId) === String(userId));
    let action = 'added';
    if (existingIdx >= 0) {
      if (msg.reactions[existingIdx].emoji === emoji) {
        msg.reactions.splice(existingIdx, 1);
        action = 'removed';
      } else {
        msg.reactions[existingIdx].emoji = emoji;
        action = 'updated';
      }
    } else {
      msg.reactions.push({
        emoji,
        userId,
        senderType,
        userName: req.admin ? (req.admin.firstName || 'Admin') : (req.user?.firstName || 'User'),
        createdAt: new Date()
      });
    }
    msg.reaction = msg.reactions.length ? msg.reactions[0].emoji : '';
    await room.save();

    // Notify via socket
    const io = req.app.get('socketio');
    if (io) {
      const eventData = {
        messageId,
        reactions: msg.reactions,
        reaction: msg.reaction,
        action,
        roomId
      };
      io.to(`chat_${roomId}`).emit("messageUpdated", eventData);
      io.to('adminRoom').emit("messageUpdated", eventData);
    }

    res.json({
      messageId,
      reactions: msg.reactions,
      reaction: msg.reaction,
      action
    });
  } catch (err) {
    console.error('Error in addReaction:', err);
    res.status(err.statusCode || 500).json({ 
      message: err.message || 'Server error' 
    });
  }
};

// Get all chat rooms (optionally filter by assignedAdmin)
exports.getAllRooms = async (req, res) => {
  try {
    const adminId = req.admin._id;

    const rooms = await ChatRoom.find({ isClosed: false })
      .populate('customerId', 'firstName lastName email imageUrl')
      .populate('assignedAdmin', 'firstName lastName email imageUrl')
      .sort({ updatedAt: -1 }); // latest first

    res.json(rooms);
  } catch (err) {
    console.error("Error in getAllRooms:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Server error" });
  }
};

// Get specific chat room by ID
exports.getRoomById = async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!roomId) throw new BadRequestError("Room ID is required");

    const room = await ChatRoom.findById(roomId)
      .populate('customerId', 'firstName lastName email imageUrl')
      .populate('assignedAdmin', 'firstName lastName email imageUrl');

    if (!room) throw new NotFoundError("Chat room not found");

    res.json(room);
  } catch (err) {
    console.error("Error in getRoomById:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Server error" });
  }
};

// Mark messages as read - now handled via socket
exports.markAsRead = async (req, res) => {
  try {
    const { roomId } = req.params;
    const readerType = req.user ? "customer" : "admin";
    const readerId = req.user?._id || req.admin?._id;

    if (!roomId || !readerId) {
      throw new BadRequestError('Room ID and reader ID are required');
    }

    const room = await ChatRoom.findById(roomId);
    if (!room) {
      throw new NotFoundError('Chat room not found');
    }

    // Mark all unread messages as read by this user type
    room.messages.forEach(message => {
      const alreadyRead = message.readBy.some(read => 
        read.readerType === readerType && read.readerId.equals(readerId)
      );
      
      if (!alreadyRead) {
        message.readBy.push({
          readerType,
          readerId,
          readAt: new Date()
        });
      }
    });

    await room.save();

    // Emit read status update via socket
    const io = req.app.get('socketio');
    if (io) {
      io.to(`chat_${roomId}`).emit("messagesRead", { 
        roomId, 
        readerType,
        readerId,
        readAt: new Date()
      });
      
      // Emit message status updates for each message
      room.messages.forEach(message => {
        io.to(`chat_${roomId}`).emit("messageStatusUpdated", {
          messageId: message._id,
          updates: {
            readBy: message.readBy
          }
        });
      });
    }

    res.json({ message: "Messages marked as read" });
  } catch (err) {
    console.error('Error in markAsRead:', err);
    res.status(err.statusCode || 500).json({ 
      message: err.message || 'Server error' 
    });
  }
};

// Update online status - now handled via socket only
exports.updateOnlineStatus = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { isOnline } = req.body;
    const userId = req.user?._id || req.admin?._id;

    if (!roomId || !userId) {
      throw new BadRequestError('Room ID and user ID are required');
    }

    // Emit online status update via socket only
    const io = req.app.get('socketio');
    if (io) {
      io.to(`chat_${roomId}`).emit("onlineStatusChanged", { 
        roomId, 
        userId,
        isOnline 
      });
    }

    res.json({ message: "Online status updated" });
  } catch (err) {
    console.error('Error in updateOnlineStatus:', err);
    res.status(err.statusCode || 500).json({ 
      message: err.message || 'Server error' 
    });
  }
};
