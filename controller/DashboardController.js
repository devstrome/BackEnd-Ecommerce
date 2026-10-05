const Order = require('../models/Order');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Contact = require('../models/Contact');
const POSOrder = require('../models/POSOrder');
const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler = require('../utils/errorHandler');

// Get comprehensive dashboard statistics
exports.getDashboardStats = catchAsyncErrors(async (req, res, next) => {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  
  const startOfWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  // Today's statistics
  const todayOrders = await Order.find({
    createdAt: { $gte: startOfDay, $lt: endOfDay },
    isActive: true
  });

  const todayPOSOrders = await POSOrder.find({
    createdAt: { $gte: startOfDay, $lt: endOfDay }
  });

  const todaySales = todayOrders.reduce((sum, order) => sum + (order.grandTotal || 0), 0);
  const todayPOSSales = todayPOSOrders.reduce((sum, order) => sum + order.total, 0);
  const totalTodaySales = todaySales + todayPOSSales;

  // This week's statistics
  const weekOrders = await Order.find({
    createdAt: { $gte: startOfWeek },
    isActive: true
  });

  const weekPOSOrders = await POSOrder.find({
    createdAt: { $gte: startOfWeek }
  });

  const weekSales = weekOrders.reduce((sum, order) => sum + (order.grandTotal || 0), 0);
  const weekPOSSales = weekPOSOrders.reduce((sum, order) => sum + order.total, 0);
  const totalWeekSales = weekSales + weekPOSSales;

  // This month's statistics
  const monthOrders = await Order.find({
    createdAt: { $gte: startOfMonth },
    isActive: true
  });

  const monthPOSOrders = await POSOrder.find({
    createdAt: { $gte: startOfMonth }
  });

  const monthSales = monthOrders.reduce((sum, order) => sum + (order.grandTotal || 0), 0);
  const monthPOSSales = monthPOSOrders.reduce((sum, order) => sum + order.total, 0);
  const totalMonthSales = monthSales + monthPOSSales;

  // Order status breakdown
  const orderStatusStats = await Order.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: '$orderStatus', count: { $sum: 1 } } }
  ]);

  const posOrderStatusStats = await POSOrder.aggregate([
    { $group: { _id: '$orderStatus', count: { $sum: 1 } } }
  ]);

  // User statistics
  const totalUsers = await User.countDocuments();
  const newUsersToday = await User.countDocuments({
    createdAt: { $gte: startOfDay, $lt: endOfDay }
  });

  // Inventory statistics
  const totalProducts = await Product.countDocuments();
  const totalInventoryItems = await Inventory.countDocuments();
  const lowStockItems = await Inventory.countDocuments({ availableQuantity: { $lte: 5 } });
  const outOfStockItems = await Inventory.countDocuments({ availableQuantity: { $lte: 0 } });

  // Contact statistics
  const totalContacts = await Contact.countDocuments();
  const unreadContacts = await Contact.countDocuments({ status: 'unread' });

  // Recent orders for dashboard
  const recentOrders = await Order.find({ isActive: true })
    .populate('userId', 'firstName lastName email')
    .sort({ createdAt: -1 })
    .limit(5);

  const recentPOSOrders = await POSOrder.find()
    .populate('cashier', 'firstName lastName')
    .sort({ createdAt: -1 })
    .limit(5);

  // Top selling products (based on order items) — grouped per product with per-variant breakdown
  const topProducts = await Order.aggregate([
    { $match: { isActive: true } },
    { $unwind: '$items' },
    {
      $group: {
        _id: {
          productId: '$items.productId',
          variantId: '$items.variantId',
          size: '$items.size',
          color: '$items.color',
        },
        itemName: { $first: '$items.name' },
        mainImage: { $first: '$items.mainImage' },
        totalQuantity: { $sum: '$items.quantity' },
        totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
      },
    },
    { $sort: { totalQuantity: -1 } },
    {
      $group: {
        _id: '$_id.productId',
        totalQuantity: { $sum: '$totalQuantity' },
        totalRevenue: { $sum: '$totalRevenue' },
        variants: {
          $push: {
            variantId: '$_id.variantId',
            size: '$_id.size',
            color: '$_id.color',
            name: '$itemName',
            mainImage: '$mainImage',
            totalQuantity: '$totalQuantity',
            totalRevenue: '$totalRevenue',
          },
        },
      },
    },
    { $sort: { totalQuantity: -1, totalRevenue: -1 } },
    { $limit: 5 },
    { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
    { $unwind: '$product' },
    {
      $project: {
        totalQuantity: 1,
        totalRevenue: 1,
        variants: 1,
        product: { name: 1, mainImage: 1, brand: 1, mainPrice: 1, discountPrice: 1 },
      },
    },
  ]);

  // Sales trend for the last 7 days
  const salesTrend = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const nextDate = new Date(date.getTime() + 24 * 60 * 60 * 1000);
    
    const dayOrders = await Order.find({
      createdAt: { $gte: date, $lt: nextDate },
      isActive: true
    });
    
    const dayPOSOrders = await POSOrder.find({
      createdAt: { $gte: date, $lt: nextDate }
    });
    
    const daySales = dayOrders.reduce((sum, order) => sum + (order.grandTotal || 0), 0);
    const dayPOSSales = dayPOSOrders.reduce((sum, order) => sum + order.total, 0);
    
    salesTrend.push({
      date: date.toISOString().split('T')[0],
      sales: daySales + dayPOSSales,
      orders: dayOrders.length + dayPOSOrders.length
    });
  }

  res.status(200).json({
    success: true,
    stats: {
      // Sales statistics
      today: {
        sales: totalTodaySales,
        orders: todayOrders.length + todayPOSOrders.length,
        onlineOrders: todayOrders.length,
        posOrders: todayPOSOrders.length
      },
      week: {
        sales: totalWeekSales,
        orders: weekOrders.length + weekPOSOrders.length,
        onlineOrders: weekOrders.length,
        posOrders: weekPOSOrders.length
      },
      month: {
        sales: totalMonthSales,
        orders: monthOrders.length + monthPOSOrders.length,
        onlineOrders: monthOrders.length,
        posOrders: monthPOSOrders.length
      },
      
      // User statistics
      users: {
        total: totalUsers,
        newToday: newUsersToday
      },
      
      // Inventory statistics
      inventory: {
        totalProducts,
        totalItems: totalInventoryItems,
        lowStock: lowStockItems,
        outOfStock: outOfStockItems
      },
      
      // Contact statistics
      contacts: {
        total: totalContacts,
        unread: unreadContacts
      },
      
      // Order status breakdown
      orderStatus: orderStatusStats,
      posOrderStatus: posOrderStatusStats,
      
      // Recent data
      recentOrders: [...recentOrders, ...recentPOSOrders].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
      topProducts,
      salesTrend
    }
  });
});

// Get real-time dashboard updates
exports.getRealTimeUpdates = catchAsyncErrors(async (req, res, next) => {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

  // Get latest orders
  const latestOrders = await Order.find({ isActive: true })
    .populate('userId', 'firstName lastName email')
    .sort({ createdAt: -1 })
    .limit(3);

  const latestPOSOrders = await POSOrder.find()
    .populate('cashier', 'firstName lastName')
    .sort({ createdAt: -1 })
    .limit(3);

  // Get low stock alerts
  const lowStockAlerts = await Inventory.find({ availableQuantity: { $lte: 5 } })
    .populate('productId', 'name')
    .limit(5);

  // Get unread contacts
  const unreadContacts = await Contact.find({ status: 'unread' })
    .sort({ createdAt: -1 })
    .limit(3);

  res.status(200).json({
    success: true,
    realTimeData: {
      latestOrders: [...latestOrders, ...latestPOSOrders].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3),
      lowStockAlerts,
      unreadContacts
    }
  });
});

// Get dashboard charts data
exports.getChartData = catchAsyncErrors(async (req, res, next) => {
  const { period = '7d' } = req.query;
  const today = new Date();
  
  let startDate;
  let interval;
  
  switch (period) {
    case '7d':
      startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      interval = 'day';
      break;
    case '30d':
      startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      interval = 'day';
      break;
    case '12m':
      startDate = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
      interval = 'month';
      break;
    default:
      startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      interval = 'day';
  }

  // Sales data
  const salesData = await Order.aggregate([
    { $match: { 
      createdAt: { $gte: startDate },
      isActive: true 
    }},
    { $group: {
      _id: interval === 'day' 
        ? { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
        : { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
      sales: { $sum: '$grandTotal' },
      orders: { $sum: 1 }
    }},
    { $sort: { _id: 1 } }
  ]);

  // User registration data
  const userData = await User.aggregate([
    { $match: { createdAt: { $gte: startDate } }},
    { $group: {
      _id: interval === 'day' 
        ? { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
        : { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
      users: { $sum: 1 }
    }},
    { $sort: { _id: 1 } }
  ]);

  res.status(200).json({
    success: true,
    chartData: {
      sales: salesData,
      users: userData,
      period,
      interval
    }
  });
});
