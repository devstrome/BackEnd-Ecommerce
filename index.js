// ==============================
// Load environment & dependencies
// ==============================
const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const colors = require('colors');
const cors = require('cors');
const http = require('http');
const socketIO = require('socket.io');

// ==============================
// Load routes
// ==============================
const ProductRoutes = require('./routes/ProductRoutes');
const UserRoutes = require('./routes/UserRouter');
const ImageSliderRoutes = require('./routes/SlidersRoute');
const AdminRoutes = require('./routes/AdminRoutes');
const CartRoutes = require('./routes/CartRoutes');
const CategoriesRoutes = require('./routes/CategoriesRoutes');
const BrandRoutes = require('./routes/BrandRoutes');
const ColorRoutes = require('./routes/colorRoutes');
const SizeRoutes = require('./routes/SizeRoutes');
const GenderRoutes = require('./routes/GenderRoutes');
const BadgeRoutes = require('./routes/BadgesRoutes');
const CouponRoutes = require('./routes/CouponRoutes');
const RelatedProductRoutes = require('./routes/RelatedProductRoutes');
const OrderRoutes = require('./routes/OrderRoutes');
const MeasureTypeRoutes = require('./routes/MeasureTypeRoutes');
const ChatRoomRoutes = require('./routes/ChatRoomRoutes');
const ShippingRoutes = require('./routes/ShippingRoutes');
const CheckoutRuleRoutes = require('./routes/CheckoutRuleRoutes');
const ContactRoutes = require('./routes/contact');
const TopRatedSlidesRoutes = require('./routes/TopRatedSlidesRoute');
const InventoryRoutes = require('./routes/InventoryRoutes');
const POSRoutes = require('./routes/POSRoutes');
const CronRoutes = require('./routes/CronRoutes');
const DashboardRoutes = require('./routes/DashboardRoutes');
const PopupAdRoutes = require('./routes/popupAdRoutes');
const PartnershipRoutes = require('./routes/PartnershipRoutes');
const EmbeddingRoutes = require('./routes/EmbeddingRoutes');
const SeoRoutes = require('./routes/SeoRoutes');
const HeroSlideRoutes = require('./routes/HeroSlideRoutes');
const AnnouncementRoutes = require('./routes/AnnouncementRoutes');
const SubscriberRoutes = require('./routes/SubscriberRoutes');
const HelpPageRoutes = require('./routes/HelpPageRoutes');
const BlogRoutes = require('./routes/BlogRoutes');
const BanRoutes = require('./routes/BanRoutes');
const { chat, history, clear } = require('./controller/AIAssistantController');
const authenticate = require('./middleware/UserAuthMiddleware');

const orderController = require('./controller/OrderController');
const inventoryController = require('./controller/InventoryController');
const productController = require('./controller/productController');
const cronManager = require('./utils/cronManager');
const { setSocketIO: setStoreEventsIO } = require('./utils/storeEvents');

// ==============================
// Initialize environment & DB
// ==============================
const path = require('path');
dotenv.config({ path: path.join(__dirname, '.env') });
connectDB();

// ==============================
// Initialize Express & HTTP Server
// ==============================
const app = express();
const server = http.createServer(app);

// ==============================
// Middleware
// ==============================
app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:5173",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  credentials: true,
}));
// Trust the first proxy hop so req.ip reflects the real client for the ban list
app.set('trust proxy', 1);
// Courier webhooks need the RAW body for HMAC verification -> mount BEFORE express.json()
app.use('/api/courier/webhook', require('./routes/CourierWebhookRoutes'));
app.use(express.json());

// ==============================
// API Routes
// ==============================
// AI Assistant — registered directly on app, before all routers, to avoid middleware interference
app.post('/api/assistant/chat', authenticate, chat);
app.get('/api/assistant/history', authenticate, history);
app.delete('/api/assistant/clear', authenticate, clear);

app.use("/api", ProductRoutes);
app.use("/api", UserRoutes);
app.use("/api", ImageSliderRoutes);
app.use("/api", AdminRoutes);
app.use("/api", CartRoutes);
app.use("/api", CategoriesRoutes);
app.use("/api", BrandRoutes);
app.use('/api', ColorRoutes);
app.use('/api', SizeRoutes);
app.use('/api', GenderRoutes);
app.use('/api', BadgeRoutes);
app.use('/api', CouponRoutes);
app.use('/api', RelatedProductRoutes);
app.use('/api', OrderRoutes);
app.use('/api', MeasureTypeRoutes);
app.use('/api', ChatRoomRoutes);
app.use('/api', ShippingRoutes);
app.use('/api', CheckoutRuleRoutes);
app.use('/api/courier', require('./routes/CourierRoutes'));
app.use('/api/contact', ContactRoutes);
app.use('/api', TopRatedSlidesRoutes);
app.use('/api', InventoryRoutes);
app.use('/api/pos', POSRoutes);
app.use('/api/cron', CronRoutes);
app.use('/api/dashboard', DashboardRoutes);
app.use('/api', PopupAdRoutes);
app.use('/api', PartnershipRoutes);
app.use('/api', EmbeddingRoutes);
app.use('/api', SeoRoutes);
app.use('/api', HeroSlideRoutes);
app.use('/api', AnnouncementRoutes);
app.use('/api', SubscriberRoutes);
app.use('/api', HelpPageRoutes);
app.use('/api', BlogRoutes);
app.use('/api', BanRoutes);

// ==============================
// Socket.IO Configuration
// ==============================
const io = socketIO(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Socket.IO authentication middleware
// Allow anonymous sockets for public features (e.g., product viewers)
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    console.log('ℹ️ Socket connection: No token provided (anonymous allowed for public events)');
    socket.data = { isAuthenticated: false };
    return next();
  }
  try {
    // In production, verify JWT here and set socket.data.user
    socket.data = { isAuthenticated: true };
    console.log('✅ Socket connection: Token provided', String(token).substring(0, 20) + '...');
    return next();
  } catch (error) {
    console.log('❌ Socket connection: Invalid token (proceeding as anonymous)');
    socket.data = { isAuthenticated: false };
    return next();
  }
});

// Set socket.io instance in app for controllers to access
app.set('socketio', io);

// Set socket.io instance in controllers
orderController.setSocketIO(io);
inventoryController.setSocketIO(io);
productController.setSocketIO(io);
setStoreEventsIO(io);

// ==============================
// Connected users
// ==============================
const connectedUsers = new Map();
// Track product viewers: productId -> Set(socketId)
const productViewers = new Map();
// Track which products a socket is viewing: socketId -> Set(productId)
const socketProducts = new Map();
// Expose viewer tracking to routes (live viewers dashboard)
app.set('productViewers', productViewers);
// Track user online status: userId -> { socketId, lastActivity, userType }
const userOnlineStatus = new Map();

// ==============================
// Socket.IO Event Handlers
// ==============================
io.on('connection', (socket) => {
  console.log('🔌 New client connected:', socket.id);

  // ======================
  // Join user room
  // ======================
  socket.on('joinUserRoom', (userId) => {
    if (!userId) return;
    socket.join(`user_${userId}`);
    connectedUsers.set(socket.id, { userId, userType: 'user' });
    
    // Track user online status
    userOnlineStatus.set(userId, {
      socketId: socket.id,
      lastActivity: new Date(),
      userType: 'user'
    });
    
    // Notify admin room about user coming online
    io.to('adminRoom').emit('userOnlineStatus', {
      userId,
      isOnline: true,
      lastActivity: new Date()
    });
    
    console.log(`👤 User ${userId} joined room user_${userId}`);
  });

  // ======================
  // Join admin room
  // ======================
  socket.on('joinAdminRoom', () => {
    socket.join('adminRoom');
    connectedUsers.set(socket.id, { userType: 'admin' });
    console.log(`🛡️ Admin joined admin room`);
  });

  // ======================
  // Get online users list
  // ======================
  socket.on('getOnlineUsers', () => {
    const onlineUsers = Array.from(userOnlineStatus.keys());
    socket.emit('onlineUsersList', { onlineUsers });
    console.log(`📋 Sent online users list to admin: ${onlineUsers.length} users`);
  });

  // ======================
  // User login event (when user logs in)
  // ======================
  socket.on('userLogin', (userId) => {
    if (!userId) return;
    
    // Track user online status
    userOnlineStatus.set(userId, {
      socketId: socket.id,
      lastActivity: new Date(),
      userType: 'user'
    });
    
    // Notify admin room about user coming online
    io.to('adminRoom').emit('userOnlineStatus', {
      userId,
      isOnline: true,
      lastActivity: new Date()
    });
    
    console.log(`👤 User ${userId} logged in and is now online`);
  });

  // ======================
  // Dashboard events
  // ======================
  socket.on('joinDashboard', () => {
    socket.join('dashboardRoom');
    connectedUsers.set(socket.id, { userType: 'admin', room: 'dashboard' });
    console.log(`📊 Admin joined dashboard room`);
  });

  // ======================
  // User activity tracking
  // ======================
  socket.on('userActivity', (data) => {
    const { userId, activity } = data;
    if (!userId) return;
    
    // Update user's last activity
    if (userOnlineStatus.has(userId)) {
      userOnlineStatus.get(userId).lastActivity = new Date();
    }
    
    // Notify admin room about user activity
    io.to('adminRoom').emit('userActivity', {
      userId,
      activity,
      timestamp: new Date()
    });
    
    console.log(`👤 User ${userId} activity: ${activity}`);
  });

  // ======================
  // User online status updates
  // ======================
  socket.on('updateUserStatus', (data) => {
    const { userId, status } = data;
    if (!userId) return;
    
    if (status === 'online') {
      if (!userOnlineStatus.has(userId)) {
        userOnlineStatus.set(userId, {
          socketId: socket.id,
          lastActivity: new Date(),
          userType: 'user'
        });
      }
    } else if (status === 'offline') {
      userOnlineStatus.delete(userId);
    }
    
    // Notify admin room about status change
    io.to('adminRoom').emit('userOnlineStatus', {
      userId,
      isOnline: status === 'online',
      lastActivity: new Date()
    });
  });

  // ======================
  // Chat room logic
  // ======================
  socket.on('joinChatRoom', ({ roomId, userId, userType }) => {
    if (!roomId) {
      console.log('❌ joinChatRoom: Missing roomId');
      return;
    }
    
    socket.join(`chat_${roomId}`);
    
    if (userType === 'admin') {
      // For admin connections, userId might be the admin's ID or undefined
      connectedUsers.set(socket.id, { userId, userType, roomId });
      console.log(`🛡️ Admin joined chat_${roomId}`);
    } else {
      // For user connections, userId is required
      if (!userId) {
        console.log('❌ joinChatRoom: Missing userId for user connection');
        return;
      }
      connectedUsers.set(socket.id, { userId, userType, roomId });
      console.log(`👤 User ${userId} (${userType}) joined chat_${roomId}`);
    }
    
    // Notify admin room about user joining
    if (userType !== 'admin') {
      io.to('adminRoom').emit('userJoinedRoom', { roomId, userId, userType });
    }
  });

  socket.on('sendMessage', async (message) => {
    const { roomId, senderId, senderType, text, image, tempId } = message;
    const hasText = typeof text === 'string' && text.trim().length > 0;
    const hasImage = typeof image === 'string' && image.trim().length > 0;
    if (!roomId || !senderId || (!hasText && !hasImage)) {
      console.log('❌ sendMessage: Missing required fields', { roomId, senderId, text, image });
      return;
    }
    
    try {
      // Save message to database with retry logic
      const ChatRoom = require('./models/ChatRoom');
      const mongoose = require('mongoose');
      
      let retries = 3;
      let room = null;
      let savedMessage = null;
      
      while (retries > 0) {
        try {
          room = await ChatRoom.findById(roomId);
          if (!room) {
            console.log('❌ sendMessage: Room not found', roomId);
            return;
          }
          
          if (room.isClosed) {
            console.log('❌ sendMessage: Cannot send message to closed room', roomId);
            return;
          }
          
          // Create message with proper structure and explicit _id
          const newMessage = {
            _id: new mongoose.Types.ObjectId(), // Explicitly set _id
            senderId, 
            senderType, 
            text: hasText ? text : '',
            image: hasImage ? image : '',
            reaction: "",
            reactions: [],
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
          savedMessage = room.messages[room.messages.length - 1];
          
          break; // Success, exit retry loop
          
        } catch (saveError) {
          retries--;
          if (saveError.name === 'VersionError' && retries > 0) {
            console.log(`⚠️ Version conflict in sendMessage, retrying... (${retries} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, 100)); // Small delay before retry
            continue;
          } else {
            throw saveError; // Re-throw if not a version error or no retries left
          }
        }
      }
      
      if (savedMessage) {
        // Use toObject() to ensure proper serialization
        const messageData = { ...savedMessage.toObject(), roomId };
        
        // Emit to all users in the room
        io.to(`chat_${roomId}`).emit('messageReceived', messageData);
        io.to('adminRoom').emit('messageReceived', messageData);
        
        // Emit message confirmation for temporary messages (echo the sender's tempId back)
        io.to(`chat_${roomId}`).emit('messageConfirmed', {
          tempId: tempId || `temp_${Date.now()}`,
          realId: savedMessage._id,
          updates: {
            _id: savedMessage._id,
            readBy: savedMessage.readBy
          }
        });
        
        console.log(`✉️ Message saved and sent to chat_${roomId} by ${senderId} (${senderType})`);
      }
      
    } catch (error) {
      console.error('❌ Error saving message:', error);
      // Emit error back to sender
      socket.emit('messageError', { error: 'Failed to save message' });
    }
  });

  // Toggle an emoji reaction on a message (both client and admin sides emit this)
  socket.on('addReaction', async (payload) => {
    try {
      const { roomId, messageId, emoji, userId, userName } = payload || {};
      if (!roomId || !messageId || !emoji) {
        console.log('❌ addReaction: Missing required fields', { roomId, messageId, emoji });
        return;
      }

      const ChatRoom = require('./models/ChatRoom');
      const room = await ChatRoom.findById(roomId);
      if (!room) {
        console.log('❌ addReaction: Room not found', roomId);
        return;
      }

      const msg = room.messages.id(messageId);
      if (!msg) {
        console.log('❌ addReaction: Message not found', messageId);
        return;
      }

      const senderType = payload.senderType === 'admin' ? 'admin' : 'customer';
      if (!msg.reactions) msg.reactions = [];

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
          userName: userName || '',
          createdAt: new Date()
        });
      }

      // Keep legacy single-reaction field in sync for older clients
      msg.reaction = msg.reactions.length ? msg.reactions[0].emoji : '';

      await room.save();

      const eventData = {
        messageId,
        reactions: msg.reactions,
        reaction: msg.reaction,
        action,
        roomId
      };
      io.to(`chat_${roomId}`).emit('messageUpdated', eventData);
      io.to('adminRoom').emit('messageUpdated', eventData);

      console.log(`👍 Reaction ${action} on ${messageId} in chat_${roomId}: ${emoji}`);
    } catch (error) {
      console.error('❌ Error adding reaction:', error);
    }
  });

  // Edit own message (broadcast to both sides)
  socket.on('editMessage', async ({ roomId, messageId, text, senderId }) => {
    try {
      if (!roomId || !messageId || !senderId) {
        console.log('❌ editMessage: Missing required fields', { roomId, messageId, senderId });
        return;
      }
      const ChatRoom = require('./models/ChatRoom');
      const room = await ChatRoom.findById(roomId);
      if (!room) return;
      const msg = room.messages.id(messageId);
      if (!msg) {
        socket.emit('messageError', { error: 'Message not found' });
        return;
      }
      if (String(msg.senderId) !== String(senderId)) {
        socket.emit('messageError', { error: 'Not allowed to edit this message' });
        return;
      }
      if (msg.isDeleted) return;
      const newText = typeof text === 'string' ? text.trim() : '';
      if (!newText && !msg.image) {
        socket.emit('messageError', { error: 'Message text required' });
        return;
      }
      msg.text = newText;
      msg.edited = true;
      await room.save();

      const eventData = { messageId, updates: { text: msg.text, edited: true }, roomId };
      io.to(`chat_${roomId}`).emit('messageUpdated', eventData);
      io.to('adminRoom').emit('messageUpdated', eventData);
      console.log(`✏️ Message ${messageId} edited in chat_${roomId}`);
    } catch (error) {
      console.error('❌ Error editing message:', error);
      socket.emit('messageError', { error: 'Failed to edit message' });
    }
  });

  // Delete own message (soft delete, broadcast to both sides)
  socket.on('deleteMessage', async ({ roomId, messageId, senderId }) => {
    try {
      if (!roomId || !messageId || !senderId) {
        console.log('❌ deleteMessage: Missing required fields', { roomId, messageId, senderId });
        return;
      }
      const ChatRoom = require('./models/ChatRoom');
      const room = await ChatRoom.findById(roomId);
      if (!room) return;
      const msg = room.messages.id(messageId);
      if (!msg) {
        socket.emit('messageError', { error: 'Message not found' });
        return;
      }
      if (String(msg.senderId) !== String(senderId)) {
        socket.emit('messageError', { error: 'Not allowed to delete this message' });
        return;
      }
      if (msg.isDeleted) return;
      msg.isDeleted = true;
      msg.text = '';
      msg.image = '';
      msg.edited = false;
      msg.reactions = [];
      msg.reaction = '';
      await room.save();

      const eventData = {
        messageId,
        updates: { isDeleted: true, text: '', image: '', edited: false, reactions: [], reaction: '' },
        roomId
      };
      io.to(`chat_${roomId}`).emit('messageUpdated', eventData);
      io.to('adminRoom').emit('messageUpdated', eventData);
      console.log(`🗑️ Message ${messageId} deleted in chat_${roomId}`);
    } catch (error) {
      console.error('❌ Error deleting message:', error);
      socket.emit('messageError', { error: 'Failed to delete message' });
    }
  });

  // ======================
  // Product viewers logic
  // ======================
  socket.on('joinProduct', (productId) => {
    if (!productId) return;
    // Track socket in product viewer set
    if (!productViewers.has(productId)) productViewers.set(productId, new Set());
    productViewers.get(productId).add(socket.id);
    // Track product on socket
    if (!socketProducts.has(socket.id)) socketProducts.set(socket.id, new Set());
    socketProducts.get(socket.id).add(productId);
    // Join product room and emit viewer count
    socket.join(`product_${productId}`);
    const count = productViewers.get(productId).size;
    io.to(`product_${productId}`).emit('viewerCountUpdate', count);
    io.to('adminRoom').emit('viewerCountUpdate', { productId, viewerCount: count });
    console.log(`👀 Socket ${socket.id} joined product ${productId}. Viewers: ${count}`);
  });

  socket.on('leaveProduct', (productId) => {
    if (!productId) return;
    if (productViewers.has(productId)) {
      productViewers.get(productId).delete(socket.id);
      const count = productViewers.get(productId).size;
      io.to(`product_${productId}`).emit('viewerCountUpdate', count);
      io.to('adminRoom').emit('viewerCountUpdate', { productId, viewerCount: count });
      console.log(`👋 Socket ${socket.id} left product ${productId}. Viewers: ${count}`);
    }
    socket.leave(`product_${productId}`);
    if (socketProducts.has(socket.id)) {
      socketProducts.get(socket.id).delete(productId);
      if (socketProducts.get(socket.id).size === 0) socketProducts.delete(socket.id);
    }
  });

  // Handle marking messages as read via socket
  socket.on('markMessagesAsRead', async (data) => {
    const { roomId, readerType, readerId } = data;
    if (!roomId || !readerType || !readerId) {
      console.log('❌ markMessagesAsRead: Missing required fields', { roomId, readerType, readerId });
      return;
    }
    
    try {
      // Update database with retry logic for concurrency issues
      const ChatRoom = require('./models/ChatRoom');
      
      let retries = 3;
      let room = null;
      
      while (retries > 0) {
        try {
          room = await ChatRoom.findById(roomId);
          if (!room) {
            console.log('❌ markMessagesAsRead: Room not found', roomId);
            return;
          }
          
          // Mark all unread messages as read by this user type
          let hasChanges = false;
          room.messages.forEach(message => {
            const alreadyRead = message.readBy.some(read => 
              read.readerType === readerType && read.readerId.toString() === readerId
            );
            
            if (!alreadyRead) {
              message.readBy.push({
                readerType,
                readerId,
                readAt: new Date()
              });
              hasChanges = true;
            }
          });
          
          // Only save if there are actual changes
          if (hasChanges) {
            await room.save();
            console.log(`👁️ Messages marked as read in chat_${roomId} by ${readerId} (${readerType})`);

            // Emit read status update to all users in the room (only when something changed)
            io.to(`chat_${roomId}`).emit('readStatusUpdated', { 
              roomId, 
              readerType, 
              readerId,
              readAt: new Date(),
              messageCount: room.messages.length
            });
            
            // Emit message status updates for each message
            room.messages.forEach(message => {
              io.to(`chat_${roomId}`).emit('messageStatusUpdated', {
                messageId: message._id,
                updates: {
                  readBy: message.readBy
                }
              });
            });
            
            // Emit to admin room for real-time updates
            io.to('adminRoom').emit('readStatusUpdated', {
              roomId,
              readerType,
              readerId,
              readAt: new Date()
            });
          } else {
            console.log(`👁️ No new messages to mark as read in chat_${roomId} by ${readerId} (${readerType})`);
          }
          
          break; // Success, exit retry loop
          
        } catch (saveError) {
          retries--;
          if (saveError.name === 'VersionError' && retries > 0) {
            console.log(`⚠️ Version conflict, retrying... (${retries} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, 100)); // Small delay before retry
            continue;
          } else {
            throw saveError; // Re-throw if not a version error or no retries left
          }
        }
      }
      
    } catch (error) {
      console.error('❌ Error marking messages as read:', error);
      // Don't emit error to client to avoid UI issues
    }
  });

  // Handle online status updates via socket
  socket.on('updateOnlineStatus', (data) => {
    const { roomId, userId, isOnline } = data;
    if (!roomId || !userId) {
      console.log('❌ updateOnlineStatus: Missing required fields', { roomId, userId });
      return;
    }
    
    // Emit to all users in the room
    io.to(`chat_${roomId}`).emit('onlineStatusChanged', { 
      roomId, 
      userId, 
      isOnline 
    });
    console.log(`🟢 Online status updated in chat_${roomId}: ${userId} is ${isOnline ? 'online' : 'offline'}`);
  });

  // Handle room updates via socket
  socket.on('updateRoom', (data) => {
    const { roomId, updates } = data;
    if (!roomId || !updates) {
      console.log('❌ updateRoom: Missing required fields', { roomId, updates });
      return;
    }
    
    // Emit to all users in the room
    io.to(`chat_${roomId}`).emit('roomUpdated', { 
      roomId, 
      updates 
    });
    console.log(`🔄 Room updated in chat_${roomId}:`, updates);
  });

  // Handle get room data via socket
  socket.on('getRoomData', async (data) => {
    const { userId } = data;
    if (!userId) {
      console.log('❌ getRoomData: Missing userId');
      socket.emit('roomDataReceived', null);
      return;
    }
    
    try {
      const ChatRoom = require('./models/ChatRoom');
      
      const room = await ChatRoom.findOne({
        customerId: userId,
        isClosed: false
      })
      .populate('customerId', 'firstName lastName email profileImage')
      .populate('assignedAdmin', 'firstName lastName email');

      if (room) {
        console.log(`📦 Room data sent via socket for user ${userId}`);
        socket.emit('roomDataReceived', room);
      } else {
        // Create new room if none exists
        const newRoom = await ChatRoom.create({ 
          customerId: userId,
          messages: []
        });
        
        const populatedRoom = await ChatRoom.findById(newRoom._id)
          .populate('customerId', 'firstName lastName email profileImage')
          .populate('assignedAdmin', 'firstName lastName email');
        
        console.log(`📦 New room created and sent via socket for user ${userId}`);
        socket.emit('roomDataReceived', populatedRoom);
        
        // Notify admin room about new chat
        io.to('adminRoom').emit('newChatRoom', populatedRoom);
      }
    } catch (error) {
      console.error('❌ Error getting room data via socket:', error);
      socket.emit('roomDataReceived', null);
    }
  });

  // Typing indicator events
  socket.on('typingStart', ({ roomId, senderId, senderType }) => {
    if (!roomId || !senderId) {
      console.log('❌ typingStart: Missing required fields', { roomId, senderId });
      return;
    }
    
    // Emit to all users in the room except the sender
    socket.to(`chat_${roomId}`).emit('userTyping', { 
      roomId, 
      senderId, 
      senderType,
      isTyping: true 
    });
    console.log(`⌨️ User ${senderId} started typing in chat_${roomId}`);
  });

  socket.on('typingStop', ({ roomId, senderId, senderType }) => {
    if (!roomId || !senderId) {
      console.log('❌ typingStop: Missing required fields', { roomId, senderId });
      return;
    }
    
    // Emit to all users in the room except the sender
    socket.to(`chat_${roomId}`).emit('userTyping', { 
      roomId, 
      senderId, 
      senderType,
      isTyping: false 
    });
    console.log(`⌨️ User ${senderId} stopped typing in chat_${roomId}`);
  });

  // Handle product update events from admin
  socket.on('productUpdated', (data) => {
    console.log('Product update event received:', data);
    // Emit to product room
    io.to(`product_${data.productId}`).emit('productUpdate', {
      productId: data.productId,
      updateType: data.updateType,
      timestamp: data.timestamp
    });
  });

  // Handle inventory assignment events from admin
  socket.on('inventoryAssigned', (data) => {
    console.log('Inventory assignment event received:', data);
    // Emit to product room
    io.to(`product_${data.productId}`).emit('inventoryAssignment', {
      productId: data.productId,
      variantId: data.variantId,
      size: data.size,
      action: data.action,
      inventoryId: data.inventoryId,
      orderId: data.orderId,
      timestamp: data.timestamp
    });
  });

  // Handle inventory removal events from admin
  socket.on('inventoryRemoved', (data) => {
    console.log('Inventory removal event received:', data);
    // Emit to product room
    io.to(`product_${data.productId}`).emit('inventoryAssignment', {
      productId: data.productId,
      variantId: data.variantId,
      size: data.size,
      action: data.action,
      inventoryId: data.inventoryId,
      orderId: data.orderId,
      timestamp: data.timestamp
    });
  });

  // Handle order update events from admin
  socket.on('orderUpdated', (data) => {
    console.log('Order update event received:', data);
    // Emit to admin room for monitoring
    io.to('adminRoom').emit('admin:updateOrder', {
      orderId: data.orderId,
      updateType: data.updateType,
      data: data,
      timestamp: data.timestamp
    });
    
    // Emit to user room if we have the user ID
    if (data.userId) {
      io.to(`user_${data.userId}`).emit('user:orderUpdate', {
        orderId: data.orderId,
        updateType: data.updateType,
        data: data,
        timestamp: data.timestamp
      });
    }
  });

  socket.on('disconnect', () => {
    const userData = connectedUsers.get(socket.id);
    if (userData) {
      console.log(`❌ Client disconnected: ${userData.userId || 'Admin'} (${userData.userType})`);
      
      // If it's a user disconnecting, update their online status
      if (userData.userId && userData.userType === 'user') {
        userOnlineStatus.delete(userData.userId);
        
        // Notify admin room about user going offline
        io.to('adminRoom').emit('userOnlineStatus', {
          userId: userData.userId,
          isOnline: false,
          lastActivity: new Date()
        });
      }
      
      connectedUsers.delete(socket.id);
    } else {
      console.log('❌ Anonymous client disconnected');
    }
    // Clean up product viewer tracking for this socket
    const products = socketProducts.get(socket.id);
    if (products && products.size > 0) {
      products.forEach((pid) => {
        if (productViewers.has(pid)) {
          productViewers.get(pid).delete(socket.id);
          const count = productViewers.get(pid).size;
          io.to(`product_${pid}`).emit('viewerCountUpdate', count);
          io.to('adminRoom').emit('viewerCountUpdate', { productId: pid, viewerCount: count });
        }
      });
      socketProducts.delete(socket.id);
    }
  });
});

// ==============================
// Error Handling Middleware
// ==============================
const ErrorHandler = require('./utils/errorHandler');

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.log(`Error: ${err.message}`);
  console.log('Shutting down the server due to Unhandled Promise Rejection');
  server.close(() => {
    process.exit(1);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.message = err.message || 'Internal Server Error';

  // Wrong MongoDB Id error
  if (err.name === 'CastError') {
    const message = `Resource not found. Invalid: ${err.path}`;
    err = new ErrorHandler(message, 400);
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const message = `Duplicate ${Object.keys(err.keyValue)} entered`;
    err = new ErrorHandler(message, 400);
  }

  // Wrong JWT error
  if (err.name === 'JsonWebTokenError') {
    const message = 'JSON Web Token is invalid. Try Again!';
    err = new ErrorHandler(message, 401);
  }

  // JWT Expire error
  if (err.name === 'TokenExpiredError') {
    const message = 'JSON Web Token is expired. Try Again!';
    err = new ErrorHandler(message, 401);
  }

  res.status(err.statusCode).json({
    success: false,
    message: err.message,
  });
});

// ==============================
// Start Server
// ==============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`.bgBlue);
  
  // Initialize cron manager after server starts
  try {
    cronManager.initializeCronJobs();
    console.log('✅ Cron manager initialized successfully'.green);
  } catch (error) {
    console.error('❌ Failed to initialize cron manager:', error);
  }
});
