const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const mongoose = require('mongoose');

/**
 * Assign inventory items to an order
 * @param {Array} orderItems - Array of order items with productId, variantId, size, quantity
 * @param {mongoose.Types.ObjectId} orderId - The order ID for tracking
 * @returns {Object} - { success: boolean, assignedItems: Array, errors: Array }
 */
async function assignInventoryToOrder(orderItems, orderId) {
  const assignedItems = [];
  const errors = [];
  const session = await mongoose.startSession();
  
  try {
    await session.withTransaction(async () => {
      for (const item of orderItems) {
        const { productId, variantId, size, quantity } = item;
        
        // Find available inventory items for this product variant and size
        const availableInventory = await Inventory.find({
          productId,
          variantId,
          size,
          status: 'active',
          assignedQuantity: 0
        }).limit(quantity).session(session);
        
        if (availableInventory.length < quantity) {
          errors.push(`Insufficient inventory for ${item.name} (${size}). Available: ${availableInventory.length}, Required: ${quantity}`);
          continue;
        }
        
        // Assign inventory items
        const inventoryIds = [];
        for (const inventoryItem of availableInventory) {
          inventoryItem.assignedQuantity = 1;
          inventoryItem.status = 'out_of_stock';
          inventoryItem.availableQuantity = 0;
          await inventoryItem.save({ session });
          inventoryIds.push(inventoryItem._id);
        }
        
        assignedItems.push({
          orderItem: item,
          assignedInventoryIds: inventoryIds,
          quantity: quantity
        });
      }
    });
    
    return {
      success: errors.length === 0,
      assignedItems,
      errors
    };
  } catch (error) {
    console.error('Error assigning inventory:', error);
    return {
      success: false,
      assignedItems: [],
      errors: [error.message]
    };
  } finally {
    session.endSession();
  }
}

/**
 * Release inventory items from an order (for cancellation, refund, etc.)
 * @param {Array} orderItems - Array of order items with assignedInventoryItems
 * @param {string} reason - Reason for release (cancelled, refunded, etc.)
 * @returns {Object} - { success: boolean, releasedItems: Array, errors: Array }
 */
async function releaseInventoryFromOrder(orderItems, reason = 'order_cancelled', existingSession = null) {
  const releasedItems = [];
  const errors = [];
  const ownsSession = !existingSession;
  const session = existingSession || await mongoose.startSession();
  const processedInventoryIds = new Set();

  const restore = async () => {
    for (const item of orderItems || []) {
      const assignedItems = item?.assignedInventoryItems || [];
      for (const inventoryId of assignedItems) {
        const inventoryKey = String(inventoryId?._id || inventoryId);
        if (!inventoryKey || processedInventoryIds.has(inventoryKey)) continue;
        processedInventoryIds.add(inventoryKey);

        const inventoryItem = await Inventory.findById(inventoryKey).session(session);
        if (!inventoryItem) {
          errors.push(`Inventory item ${inventoryKey} not found`);
          continue;
        }

        // A unit already released by a previous cancellation/refund should not
        // increment product stock a second time.
        if (Number(inventoryItem.assignedQuantity || 0) <= 0) continue;

        inventoryItem.assignedQuantity = 0;
        inventoryItem.status = 'active';
        inventoryItem.availableQuantity = Math.max(0, Number(inventoryItem.stockQuantity || 1));
        await inventoryItem.save({ session });

        const productId = item.productId?._id || item.productId || inventoryItem.productId;
        const variantId = item.variantId?._id || item.variantId || inventoryItem.variantId;
        const product = await Product.findById(productId).session(session);
        const variant = product?.variants?.id(variantId);
        if (product && variant) {
          const configuration = item.configuration || {};
          const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
          const size = configuration.size || item.size || inventoryItem.size;
          const option = variant.options?.find(candidate =>
            same(candidate.size, size) &&
            same(candidate.measureType, configuration.measureType || item.measureType) &&
            same(candidate.unitName, configuration.unitName || item.unitName)
          );
          const sizeIndex = (variant.sizes || []).findIndex(candidate => same(candidate, size));

          if (option || sizeIndex !== -1) {
            if (!variant.stockBySize || variant.stockBySize.length !== (variant.sizes || []).length) {
              variant.stockBySize = new Array((variant.sizes || []).length).fill(0);
            }
            if (sizeIndex !== -1) variant.stockBySize[sizeIndex] = Number(variant.stockBySize[sizeIndex] || 0) + 1;
            if (option) option.stock = Number(option.stock || 0) + 1;
            variant.stock = variant.options?.length
              ? variant.options.reduce((sum, entry) => sum + Number(entry.stock || 0), 0)
              : (variant.stockBySize || []).reduce((sum, count) => sum + Number(count || 0), 0);
            await product.save({ session });
          }
        }

        releasedItems.push({
          inventoryId: inventoryItem._id,
          productId: inventoryItem.productId,
          variantId: inventoryItem.variantId,
          size: inventoryItem.size,
          reason,
        });
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
  };
  
  try {
    if (ownsSession) await session.withTransaction(restore);
    else await restore();
    
    return {
      success: errors.length === 0,
      releasedItems,
      errors
    };
  } catch (error) {
    console.error('Error releasing inventory:', error);
    return {
      success: false,
      releasedItems: ownsSession ? [] : releasedItems,
      errors: errors.length ? errors : [error.message]
    };
  } finally {
    if (ownsSession) session.endSession();
  }
}

/**
 * Get inventory status for order items
 * @param {Array} orderItems - Array of order items
 * @returns {Object} - Inventory status for each item
 */
async function getInventoryStatusForOrderItems(orderItems) {
  const status = {};
  
  for (const item of orderItems) {
    const { productId, variantId, size } = item;
    
    // Count available inventory
    const availableCount = await Inventory.countDocuments({
      productId,
      variantId,
      size,
      status: 'active',
      assignedQuantity: 0
    });
    
    // Count total inventory
    const totalCount = await Inventory.countDocuments({
      productId,
      variantId,
      size
    });
    
    status[`${productId}-${variantId}-${size}`] = {
      available: availableCount,
      total: totalCount,
      inStock: availableCount > 0
    };
  }
  
  return status;
}

/**
 * Validate inventory availability before order creation
 * @param {Array} orderItems - Array of order items
 * @returns {Object} - { valid: boolean, errors: Array, inventoryStatus: Object }
 */
async function validateInventoryAvailability(orderItems) {
  const errors = [];
  const inventoryStatus = await getInventoryStatusForOrderItems(orderItems);
  
  for (const item of orderItems) {
    const { productId, variantId, size, quantity, name } = item;
    const key = `${productId}-${variantId}-${size}`;
    const status = inventoryStatus[key];
    
    if (!status.inStock) {
      errors.push(`${name} (${size}) is out of stock`);
    } else if (status.available < quantity) {
      errors.push(`Insufficient stock for ${name} (${size}). Available: ${status.available}, Required: ${quantity}`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    inventoryStatus
  };
}

module.exports = {
  assignInventoryToOrder,
  releaseInventoryFromOrder,
  getInventoryStatusForOrderItems,
  validateInventoryAvailability
};
