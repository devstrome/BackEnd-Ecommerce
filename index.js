// ==============================
// Load environment & dependencies
// ==============================
const express = require('express');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables before importing route/controller modules. Several
// existing modules read JWT and provider settings at module initialization.
dotenv.config({ path: path.join(__dirname, '.env') });

const connectDB = require('./config/db');
const colors = require('colors');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const Admin = require('./models/Admin');

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
const SeoRoutes = require('./routes/SeoRoutes');
const HeroSlideRoutes = require('./routes/HeroSlideRoutes');
const AnnouncementRoutes = require('./routes/AnnouncementRoutes');
const SubscriberRoutes = require('./routes/SubscriberRoutes');
const HelpPageRoutes = require('./routes/HelpPageRoutes');
const BlogRoutes = require('./routes/BlogRoutes');
const BanRoutes = require('./routes/BanRoutes');

const orderController = require('./controller/OrderController');
const inventoryController = require('./controller/InventoryController');
const productController = require('./controller/productController');
const cronManager = require('./utils/cronManager');
const { setSocketIO: setStoreEventsIO } = require('./utils/storeEvents');

// ==============================
// Initialize environment & DB
// ==============================
connectDB();

// ==============================
// Initialize Express & HTTP Server
// ==============================
const app = express();
const server = http.createServer(app);

// ==============================
// Middleware
// ==============================
// Baseline HTTP response protections. The API does not host executable pages,
// so CSP is managed by the frontend rather than imposed on JSON responses.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  strictTransportSecurity: process.env.NODE_ENV === 'production' ? undefined : false,
}));
app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:5173",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  credentials: true,
}));
// Trust only the proxy hops explicitly configured by the deployment. Leaving
// this at 0 prevents clients that reach Node directly from spoofing X-Forwarded-For.
const proxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || '0', 10);
app.set('trust proxy', Number.isInteger(proxyHops) && proxyHops >= 0 ? proxyHops : 0);
// Courier webhooks need the RAW body for HMAC verification -> mount BEFORE express.json()
app.use('/api/courier/webhook', require('./routes/CourierWebhookRoutes'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb', parameterLimit: 100 }));

// ==============================
// API Routes
// ==============================
app.use("/api", ProductRoutes);
app.use("/api", UserRoutes);
app.use("/api", ImageSliderRoutes);
app.use("/api", AdminRoutes);
app.use("/api", CartRoutes);
app.use("/api", CategoriesRoutes);
app.use("/api", BrandRoutes);
app.use('/api', require('./routes/RegionRoutes'));
app.use('/api', require('./routes/FinanceRoutes'));
app.use('/api', require('./routes/LoyaltyRoutes'));
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
  // Chat images are uploaded separately; realtime events only need text and
  // short URLs. This avoids accepting megabyte-sized websocket payloads.
  maxHttpBufferSize: 64 * 1024,
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Socket.IO authentication. Public browsing may connect anonymously, while
// identity-bearing events use the same signed, active access tokens as HTTP.
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    socket.data = { isAuthenticated: false, userType: 'guest' };
    return next();
  }
  try {
    if (typeof token !== 'string' || !process.env.JWT_SECRET) throw new Error('Invalid socket token');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const isAdminToken = Boolean(decoded.adminId);
    const identityId = decoded.adminId || decoded.userId;
    if (!identityId) throw new Error('Missing token identity');

    const Model = isAdminToken ? Admin : User;
    const identityFields = isAdminToken
      ? 'accessTokens banned firstName lastName fullName superAdmin permissions'
      : 'accessTokens banned firstName lastName fullName';
    const identity = await Model.findById(identityId)
      .select(identityFields)
      .lean();
    const activeToken = identity?.accessTokens?.some((entry) =>
      entry.token === token && new Date(entry.expiresAt).getTime() > Date.now());
    if (!identity || identity.banned || !activeToken) throw new Error('Inactive socket token');

    socket.data = {
      isAuthenticated: true,
      userType: isAdminToken ? 'admin' : 'customer',
      userId: String(identityId),
      displayName: identity.fullName || [identity.firstName, identity.lastName].filter(Boolean).join(' '),
      canViewOrders: Boolean(isAdminToken && (identity.superAdmin || identity.permissions?.includes('orders'))),
    };
    return next();
  } catch {
    return next(new Error('Invalid or expired authentication token'));
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
// Track authenticated customer presence independently from chat-room metadata.
// A customer may have several tabs/devices connected at the same time.
const userOnlineStatus = new Map();
const socketUserPresence = new Map();
const isSocketAdmin = (socket) => socket.data?.isAuthenticated && socket.data.userType === 'admin';
const isSocketCustomer = (socket) => socket.data?.isAuthenticated && socket.data.userType === 'customer';
const allowChatMutation = (socket) => {
  const now = Date.now();
  const current = socket.data?.chatMutationWindow;
  if (!current || now - current.startedAt >= 60_000) {
    socket.data.chatMutationWindow = { startedAt: now, count: 1 };
    return true;
  }
  current.count += 1;
  return current.count <= 30;
};
const isSafeChatImage = (value) => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'res.cloudinary.com';
  } catch {
    return false;
  }
};
const socketOwnsChatRoom = (socket, room) => isSocketAdmin(socket)
  || (isSocketCustomer(socket) && String(room?.customerId?._id || room?.customerId) === socket.data.userId);

const emitUserOnlineStatus = (userId, isOnline) => {
  io.to('adminRoom').emit('userOnlineStatus', {
    userId,
    isOnline,
    lastActivity: new Date(),
  });
};

const registerUserPresence = (socket, rawUserId) => {
  if (!socket.data?.isAuthenticated || !rawUserId) return false;
  const userId = String(rawUserId).trim();
  if (!userId) return false;

  const previousUserId = socketUserPresence.get(socket.id);
  if (previousUserId && previousUserId !== userId) unregisterUserPresence(socket);

  let userPresence = userOnlineStatus.get(userId);
  const becameOnline = !userPresence || userPresence.sockets.size === 0;
  if (!userPresence) {
    userPresence = { sockets: new Set(), lastActivity: new Date() };
    userOnlineStatus.set(userId, userPresence);
  }

  userPresence.sockets.add(socket.id);
  userPresence.lastActivity = new Date();
  socketUserPresence.set(socket.id, userId);
  if (becameOnline) emitUserOnlineStatus(userId, true);
  return true;
};

function unregisterUserPresence(socket) {
  const userId = socketUserPresence.get(socket.id);
  if (!userId) return;

  socketUserPresence.delete(socket.id);
  const userPresence = userOnlineStatus.get(userId);
  if (!userPresence) return;

  userPresence.sockets.delete(socket.id);
  if (userPresence.sockets.size === 0) {
    userOnlineStatus.delete(userId);
    emitUserOnlineStatus(userId, false);
  }
}

// ==============================
// Socket.IO Event Handlers
// ==============================
io.on('connection', (socket) => {
  console.log('🔌 New client connected:', socket.id);

  // ======================
  // Join user room
  // ======================
  socket.on('joinUserRoom', (userId) => {
    if (!isSocketCustomer(socket) || String(userId) !== socket.data.userId) return;
    if (!registerUserPresence(socket, userId)) return;
    socket.join(`user_${String(userId)}`);
    connectedUsers.set(socket.id, { userId: String(userId), userType: 'user' });
    console.log(`👤 User ${userId} joined room user_${userId}`);
  });

  // ======================
  // Join admin room
  // ======================
  socket.on('joinAdminRoom', () => {
    if (!isSocketAdmin(socket)) return;
    socket.join('adminRoom');
    if (socket.data.canViewOrders) socket.join('adminOrdersRoom');
    connectedUsers.set(socket.id, { userType: 'admin' });
    console.log(`🛡️ Admin joined admin room`);
  });

  // ======================
  // Get online users list
  // ======================
  socket.on('getOnlineUsers', () => {
    if (!isSocketAdmin(socket)) return;
    const onlineUsers = Array.from(userOnlineStatus.keys());
    socket.emit('onlineUsersList', { onlineUsers });
    console.log(`📋 Sent online users list to admin: ${onlineUsers.length} users`);
  });

  // ======================
  // User login event (when user logs in)
  // ======================
  socket.on('userLogin', (userId) => {
    if (!isSocketCustomer(socket) || String(userId) !== socket.data.userId) return;
    if (!registerUserPresence(socket, userId)) return;
    socket.join(`user_${String(userId)}`);
    console.log(`👤 User ${userId} logged in and is now online`);
  });

  // ======================
  // Dashboard events
  // ======================
  socket.on('joinDashboard', () => {
    if (!isSocketAdmin(socket)) return;
    socket.join('dashboardRoom');
    connectedUsers.set(socket.id, { userType: 'admin', room: 'dashboard' });
    console.log(`📊 Admin joined dashboard room`);
  });

  // ======================
  // User activity tracking
  // ======================
  socket.on('userActivity', (data = {}) => {
    const { userId, activity } = data;
    if (!isSocketCustomer(socket) || String(userId) !== socket.data.userId || !activity) return;
    
    // Update user's last activity
    const userPresence = userOnlineStatus.get(String(userId));
    if (userPresence) {
      userPresence.lastActivity = new Date();
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
  socket.on('updateUserStatus', (data = {}) => {
    const { userId, status } = data;
    if (!isSocketCustomer(socket) || String(userId) !== socket.data.userId) return;
    
    if (status === 'online') {
      registerUserPresence(socket, userId);
    } else if (status === 'offline') {
      unregisterUserPresence(socket);
    }
  });

  // ======================
  // Chat room logic
  // ======================
  socket.on('joinChatRoom', async (payload = {}) => {
    if (!allowChatMutation(socket)) return;
    const { roomId, userId, userType } = payload;
    if (!roomId || !['admin', 'customer'].includes(userType)) {
      return;
    }

    try {
      const ChatRoom = require('./models/ChatRoom');
      const room = await ChatRoom.findById(roomId).select('customerId');
      if (!room || !socketOwnsChatRoom(socket, room)) return;
      if (userType === 'admin' && !isSocketAdmin(socket)) return;
      if (userType === 'customer' && (!isSocketCustomer(socket) || String(userId) !== socket.data.userId)) return;
    } catch {
      return;
    }
    
    socket.join(`chat_${roomId}`);
    
    if (userType === 'admin') {
      connectedUsers.set(socket.id, { userId: socket.data.userId, userType, roomId });
      console.log(`🛡️ Admin joined chat_${roomId}`);
    } else {
      // For user connections, userId is required
      if (!userId) {
        console.log('❌ joinChatRoom: Missing userId for user connection');
        return;
      }
      connectedUsers.set(socket.id, { userId: socket.data.userId, userType, roomId });
      console.log(`👤 User ${userId} (${userType}) joined chat_${roomId}`);
    }
    
    // Notify admin room about user joining
    if (userType !== 'admin') {
      io.to('adminRoom').emit('userJoinedRoom', { roomId, userId, userType });
    }
  });

  socket.on('sendMessage', async (message) => {
    const { roomId, text, image, tempId } = message || {};
    const senderId = socket.data?.userId;
    const senderType = socket.data?.userType;
    const hasText = typeof text === 'string' && text.trim().length > 0;
    const hasImage = typeof image === 'string' && image.trim().length > 0;
    if (!socket.data?.isAuthenticated || !['admin', 'customer'].includes(senderType) || !roomId || !senderId || (!hasText && !hasImage)) {
      return;
    }
    if (!allowChatMutation(socket) || (hasText && text.length > 5000) || (hasImage && !isSafeChatImage(image))) {
      socket.emit('messageError', { error: 'Message is too large or contains an unsupported image URL' });
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
            return;
          }

          if (!socketOwnsChatRoom(socket, room)) return;
          
          if (room.isClosed) {
            return;
          }
          
          // Create message with proper structure and explicit _id
          const newMessage = {
            _id: new mongoose.Types.ObjectId(), // Explicitly set _id
            senderId, 
            senderType, 
            senderName: socket.data.displayName || (senderType === 'admin' ? 'BELORELLA Support' : 'Customer'),
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
      const { roomId, messageId, emoji } = payload || {};
      const userId = socket.data?.userId;
      if (!socket.data?.isAuthenticated || !roomId || !messageId || typeof emoji !== 'string' || emoji.length > 16) return;
      if (!allowChatMutation(socket)) return;

      const ChatRoom = require('./models/ChatRoom');
      const room = await ChatRoom.findById(roomId);
      if (!room || !socketOwnsChatRoom(socket, room)) return;

      const msg = room.messages.id(messageId);
      if (!msg) {
        console.log('❌ addReaction: Message not found', messageId);
        return;
      }

      const senderType = socket.data.userType;
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
          userName: socket.data.displayName || '',
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
  socket.on('editMessage', async ({ roomId, messageId, text } = {}) => {
    try {
      const senderId = socket.data?.userId;
      if (!socket.data?.isAuthenticated || !roomId || !messageId || !senderId) return;
      if (typeof text !== 'string' || text.length > 5000 || !allowChatMutation(socket)) {
        socket.emit('messageError', { error: 'Message is too large or you are sending updates too quickly' });
        return;
      }
      const ChatRoom = require('./models/ChatRoom');
      const room = await ChatRoom.findById(roomId);
      if (!room || !socketOwnsChatRoom(socket, room)) return;
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
  socket.on('deleteMessage', async ({ roomId, messageId } = {}) => {
    try {
      const senderId = socket.data?.userId;
      if (!socket.data?.isAuthenticated || !roomId || !messageId || !senderId) return;
      if (!allowChatMutation(socket)) return;
      const ChatRoom = require('./models/ChatRoom');
      const room = await ChatRoom.findById(roomId);
      if (!room || !socketOwnsChatRoom(socket, room)) return;
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
    if (typeof productId !== 'string' || !/^[0-9a-f]{24}$/i.test(productId)) return;
    const safeProductId = productId.toLowerCase();
    const joinedProducts = socketProducts.get(socket.id);
    if (joinedProducts?.has(safeProductId) || joinedProducts?.size >= 10) return;
    // Track socket in product viewer set
    if (!productViewers.has(safeProductId)) productViewers.set(safeProductId, new Set());
    productViewers.get(safeProductId).add(socket.id);
    // Track product on socket
    if (!socketProducts.has(socket.id)) socketProducts.set(socket.id, new Set());
    socketProducts.get(socket.id).add(safeProductId);
    // Join product room and emit viewer count
    socket.join(`product_${safeProductId}`);
    const count = productViewers.get(safeProductId).size;
    io.to(`product_${safeProductId}`).emit('viewerCountUpdate', count);
    io.to('adminRoom').emit('viewerCountUpdate', { productId: safeProductId, viewerCount: count });
    console.log(`👀 Socket ${socket.id} joined product ${safeProductId}. Viewers: ${count}`);
  });

  socket.on('leaveProduct', (productId) => {
    if (typeof productId !== 'string' || !/^[0-9a-f]{24}$/i.test(productId)) return;
    const safeProductId = productId.toLowerCase();
    if (!socketProducts.get(socket.id)?.has(safeProductId)) return;
    if (productViewers.has(safeProductId)) {
      productViewers.get(safeProductId).delete(socket.id);
      const count = productViewers.get(safeProductId).size;
      if (count === 0) productViewers.delete(safeProductId);
      io.to(`product_${safeProductId}`).emit('viewerCountUpdate', count);
      io.to('adminRoom').emit('viewerCountUpdate', { productId: safeProductId, viewerCount: count });
      console.log(`👋 Socket ${socket.id} left product ${safeProductId}. Viewers: ${count}`);
    }
    socket.leave(`product_${safeProductId}`);
    if (socketProducts.has(socket.id)) {
      socketProducts.get(socket.id).delete(safeProductId);
      if (socketProducts.get(socket.id).size === 0) socketProducts.delete(socket.id);
    }
  });

  // Handle marking messages as read via socket
  socket.on('markMessagesAsRead', async (data) => {
    const { roomId } = data || {};
    const readerType = socket.data?.userType;
    const readerId = socket.data?.userId;
    if (!socket.data?.isAuthenticated || !roomId || !readerId) return;
    
    try {
      // Update database with retry logic for concurrency issues
      const ChatRoom = require('./models/ChatRoom');
      
      let retries = 3;
      let room = null;
      
      while (retries > 0) {
        try {
          room = await ChatRoom.findById(roomId);
          if (!room || !socketOwnsChatRoom(socket, room)) return;
          
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
  socket.on('updateOnlineStatus', async (data) => {
    const { roomId } = data || {};
    const userId = socket.data?.userId;
    if (!socket.data?.isAuthenticated || !roomId || !userId) return;
    try {
      const ChatRoom = require('./models/ChatRoom');
      const room = await ChatRoom.findById(roomId).select('customerId');
      if (!room || !socketOwnsChatRoom(socket, room)) return;
      io.to(`chat_${roomId}`).emit('onlineStatusChanged', { roomId, userId, isOnline: true });
    } catch {
      return;
    }
  });

  // Handle room updates via socket
  socket.on('updateRoom', (data) => {
    const { roomId, updates } = data || {};
    if (!isSocketAdmin(socket) || !roomId || !updates || typeof updates !== 'object') return;
    
    // Emit to all users in the room
    io.to(`chat_${roomId}`).emit('roomUpdated', { 
      roomId, 
      updates 
    });
    console.log(`🔄 Room updated in chat_${roomId}:`, updates);
  });

  // Handle get room data via socket
  socket.on('getRoomData', async (data) => {
    if (!isSocketCustomer(socket) || (data?.userId && String(data.userId) !== socket.data.userId)) {
      socket.emit('roomDataReceived', null);
      return;
    }
    const userId = socket.data.userId;
    
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
  const relayTyping = async (data, isTyping) => {
    const { roomId } = data || {};
    if (!socket.data?.isAuthenticated || !roomId) return;
    try {
      const ChatRoom = require('./models/ChatRoom');
      const room = await ChatRoom.findById(roomId).select('customerId');
      if (!room || !socketOwnsChatRoom(socket, room)) return;
      socket.to(`chat_${roomId}`).emit('userTyping', {
        roomId,
        senderId: socket.data.userId,
        senderType: socket.data.userType,
        isTyping,
      });
    } catch {
      return;
    }
  };

  socket.on('typingStart', (data) => {
    relayTyping(data, true);
  });

  socket.on('typingStop', (data) => {
    relayTyping(data, false);
  });

  // Handle product update events from admin
  socket.on('productUpdated', (data) => {
    if (!isSocketAdmin(socket) || !data?.productId) return;
    // Emit to product room
    io.to(`product_${data.productId}`).emit('productUpdate', {
      productId: data.productId,
      updateType: data.updateType,
      timestamp: data.timestamp
    });
  });

  // Handle inventory assignment events from admin
  socket.on('inventoryAssigned', (data) => {
    if (!isSocketAdmin(socket) || !data?.productId) return;
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
    if (!isSocketAdmin(socket) || !data?.productId) return;
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
    if (!isSocketAdmin(socket) || !data?.orderId) return;
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
    unregisterUserPresence(socket);
    const userData = connectedUsers.get(socket.id);
    if (userData) {
      console.log(`❌ Client disconnected: ${userData.userId || 'Admin'} (${userData.userType})`);
      
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
          if (count === 0) productViewers.delete(pid);
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
