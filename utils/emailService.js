const nodemailer = require('nodemailer');
const { BRAND, brandFrom, brandFooter } = require('./brand');

// Email configuration
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Helper function to format currency
const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency: 'BDT',
    minimumFractionDigits: 2
  }).format(amount);
};

// Helper function to format date
const formatDate = (date) => {
  return new Date(date).toLocaleDateString('en-BD', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

// Derives a friendly greeting name, falling back to fullName / email local part
const greetName = (user, order) => {
  const first = user?.firstName;
  const last = user?.lastName;
  if (first || last) return `${first || ''} ${last || ''}`.trim();
  if (user?.fullName) return user.fullName;
  const fallback = order?.shippingAddress?.fullName;
  if (fallback) return fallback;
  return '';
};

// Guarded address block (never throws on partial addresses)
const addressLines = (order) => {
  const a = order?.shippingAddress;
  if (!a) return '<p style="margin: 5px 0; color: #666;">Address not provided</p>';
  return `
    <p style="margin: 5px 0;"><strong>${a.fullName || ''}</strong></p>
    <p style="margin: 5px 0;">${a.address || ''}</p>
    <p style="margin: 5px 0;">${[a.city, a.state, a.postalCode].filter(Boolean).join(', ')}</p>
    ${a.country ? `<p style="margin: 5px 0;">${a.country}</p>` : ''}
    ${a.phone ? `<p style="margin: 5px 0;"><strong>Phone:</strong> ${a.phone}</p>` : ''}
  `;
};

// Extra fee rows (checkout rule surcharges) — empty string when none
const extraFeeRows = (order, color = '#B1123B') => {
  const fees = Array.isArray(order?.extraFees) ? order.extraFees.filter(f => f && f.amount > 0) : [];
  if (!fees.length) return '';
  return fees.map(f => `
    <p style="margin: 5px 0;"><strong>${f.label || 'Extra Fee'}:</strong> ${formatCurrency(f.amount)}</p>
  `).join('');
};

// Email templates
const emailTemplates = {
  orderConfirmation: (order, user) => ({
    subject: `Order Confirmation - Order #${order.orderId}`,
    html: `
             <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
         <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
           <div style="display: flex; align-items: center; justify-content: center; gap: 15px; margin-bottom: 10px;">
             <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME} Logo" style="width: 60px; height: 60px; object-fit: contain;">
             <h1 style="margin: 0;">${BRAND.NAME}</h1>
           </div>
           <p style="margin: 5px 0;">Premium Fashion & Lifestyle</p>
         </div>
         
         <div style="padding: 20px; background: #f8f9fa;">
           <h2 style="color: #B1123B;">Order Confirmation</h2>
          <p>Dear ${greetName(user, order)},</p>
          <p>Thank you for your order! We're excited to confirm that your order has been received and is being processed.</p>
          
          <!-- Order Summary -->
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h3 style="color: #B1123B; margin-top: 0;">Order Summary</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
              <div>
                <p><strong>Order ID:</strong> #${order.orderId}</p>
                <p><strong>Order Date:</strong> ${formatDate(order.createdAt)}</p>
                <p><strong>Order Status:</strong> <span style="color: #1B1B1B; font-weight: bold; text-transform: uppercase;">${order.orderStatus}</span></p>
                <p><strong>Payment Status:</strong> <span style="color: ${order.paymentStatus === 'completed' ? '#059669' : '#B1123B'}; font-weight: bold; text-transform: uppercase;">${order.paymentStatus}</span></p>
              </div>
              <div>
                <p><strong>Payment Method:</strong> ${order.paymentMethod}</p>
                ${order.paymentDetails?.trxId ? `<p><strong>Transaction ID:</strong> ${order.paymentDetails.trxId}</p>` : ''}
                ${order.paymentDetails?.walletNumberMasked ? `<p><strong>Wallet:</strong> ${order.paymentDetails.walletNumberMasked}</p>` : ''}
                ${order.paymentDetails?.codNote ? `<p><strong>COD Note:</strong> ${order.paymentDetails.codNote}</p>` : ''}
              </div>
            </div>
          </div>

                                           <!-- Pricing Details -->
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #B1123B; margin-top: 0;">Pricing Details</h3>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 14px;">
                <div>
                  <p><strong>Subtotal:</strong> ${formatCurrency(order.totalAmount)}</p>
                  ${order.discountAmount > 0 ? `<p><strong>Discount:</strong> -${formatCurrency(order.discountAmount)}</p>` : ''}
                  <p><strong>Shipping Cost:</strong> ${formatCurrency(order.shippingCost || 0)}</p>
                  ${extraFeeRows(order)}
                </div>
                <div style="text-align: right;">
                  <p><strong>Grand Total:</strong> ${formatCurrency(order.grandTotal)}</p>
                  ${order.couponCode ? `<p><strong>Coupon Applied:</strong> ${order.couponCode}</p>` : ''}
                </div>
              </div>
            </div>
          
          <!-- Shipping Information -->
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #B1123B; margin-top: 0;">Shipping Information</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
              <div>
                <h4 style="color: #374151; margin-top: 0;">Delivery Address</h4>
                ${addressLines(order)}
              </div>
              <div>
                <h4 style="color: #374151; margin-top: 0;">Shipping Method</h4>
                ${order.shipping?.name ? `
                  <p style="margin: 5px 0;"><strong>Method:</strong> ${order.shipping.name}</p>
                  <p style="margin: 5px 0;"><strong>Cost:</strong> ${formatCurrency(order.shipping.charge)}</p>
                  <p style="margin: 5px 0;"><strong>Estimated Delivery:</strong> ${order.shipping.estimatedDays} days</p>
                ` : '<p style="margin: 5px 0; color: #666;">Standard shipping</p>'}
              </div>
            </div>
          </div>
          
          <!-- Order Items -->
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #B1123B; margin-top: 0;">Order Items (${order.items.length} item${order.items.length > 1 ? 's' : ''})</h3>
            ${order.items.map((item, index) => `
              <div style="border-bottom: 1px solid #eee; padding: 15px 0; ${index === order.items.length - 1 ? 'border-bottom: none;' : ''}">
                <div style="display: flex; gap: 15px; align-items: start;">
                  <div style="width: 100px; height: 100px; background: #f3f4f6; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid #e5e7eb;">
                    ${item.mainImage ? `<img src="${item.mainImage}" alt="${item.name}" style="width: 100%; height: 100%; object-fit: contain; border-radius: 8px; max-width: 100%; max-height: 100%;">` : '<span style="color: #9ca3af;">No Image</span>'}
                  </div>
                  <div style="flex: 1;">
                    <h4 style="margin: 0 0 8px 0; color: #374151;">${item.name}</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 14px; color: #6b7280;">
                      <div>
                        <p style="margin: 3px 0;"><strong>Quantity:</strong> ${item.quantity}</p>
                        <p style="margin: 3px 0;"><strong>Unit Price:</strong> ${formatCurrency(item.price)}</p>
                        ${item.discountApplied > 0 ? `<p style="margin: 3px 0;"><strong>Discount:</strong> -${formatCurrency(item.discountApplied)}</p>` : ''}
                      </div>
                                             <div>
                         ${item.size ? `<p style="margin: 3px 0;"><strong>${item.measureType || 'Size'}:</strong> ${item.size} ${item.unitName || ''}</p>` : ''}
                         ${item.color ? `<p style="margin: 3px 0;"><strong>Color:</strong> ${item.color}</p>` : ''}
                       </div>
                    </div>
                    <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #f3f4f6;">
                      <p style="margin: 0; font-weight: bold; color: #B1123B;">
                        <strong>Item Total:</strong> ${formatCurrency(item.price * item.quantity)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>

                                           <!-- Order Summary -->
            <div style="background: #FDF2F5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
              <h4 style="color: #B1123B; margin-top: 0;">Order Summary</h4>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; font-size: 14px;">
                <div>
                  <p style="margin: 5px 0;"><strong>Total Items:</strong> ${order.items.reduce((sum, item) => sum + item.quantity, 0)}</p>
                  <p style="margin: 5px 0;"><strong>Subtotal:</strong> ${formatCurrency(order.totalAmount)}</p>
                  ${order.discountAmount > 0 ? `<p style="margin: 5px 0;"><strong>Discount:</strong> -${formatCurrency(order.discountAmount)}</p>` : ''}
                  <p style="margin: 5px 0;"><strong>Shipping:</strong> ${formatCurrency(order.shippingCost || 0)}</p>
                  ${extraFeeRows(order)}
                </div>
                <div style="text-align: right;">
                  <p style="margin: 5px 0; font-size: 18px; font-weight: bold; color: #B1123B;">
                    <strong>Grand Total:</strong> ${formatCurrency(order.grandTotal)}
                  </p>
                </div>
              </div>
            </div>
          
          <p>We'll keep you updated on the status of your order. You can track your order by logging into your account.</p>
          
          <!-- Order Tracking Link -->
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.CLIENT_URL}/profile/orders/${order.orderId}" 
               style="display: inline-block; background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
              📋 View Order Details
            </a>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <p style="color: #B1123B; font-weight: bold;">Thank you for choosing ${BRAND.NAME}!</p>
          </div>
        </div>
        
        <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666;">
          <p>${brandFooter()}</p>
          <p>This is an automated email. Please do not reply to this message.</p>
        </div>
      </div>
    `
  }),

  orderProcessing: (order, user) => ({
    subject: `Order Processing - Order #${order.orderId}`,
    html: `
             <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
         <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
           <div style="display: flex; align-items: center; justify-content: center; gap: 15px; margin-bottom: 10px;">
             <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME} Logo" style="width: 60px; height: 60px; object-fit: contain;">
             <h1 style="margin: 0;">${BRAND.NAME}</h1>
           </div>
           <p style="margin: 5px 0;">Premium Fashion & Lifestyle</p>
         </div>
         
         <div style="padding: 20px; background: #f8f9fa;">
           <h2 style="color: #B1123B;">Order Processing Update</h2>
          <p>Dear ${greetName(user, order)},</p>
          <p>Great news! Your order is now being processed and prepared for shipment.</p>
          
          <!-- Order Summary -->
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h3 style="color: #B1123B; margin-top: 0;">Order Details</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
              <div>
                <p><strong>Order ID:</strong> #${order.orderId}</p>
                <p><strong>Order Date:</strong> ${formatDate(order.createdAt)}</p>
                <p><strong>Status:</strong> <span style="color: #B1123B; font-weight: bold; text-transform: uppercase;">PROCESSING</span></p>
                <p><strong>Payment Status:</strong> <span style="color: ${order.paymentStatus === 'completed' ? '#059669' : '#B1123B'}; font-weight: bold; text-transform: uppercase;">${order.paymentStatus}</span></p>
              </div>
                             <div>
                 <p><strong>Payment Method:</strong> ${order.paymentMethod}</p>
                 <p><strong>Total Amount:</strong> ${formatCurrency(order.grandTotal)}</p>
                 <p><strong>Items:</strong> ${order.items.reduce((sum, item) => sum + item.quantity, 0)} items</p>
               </div>
            </div>
          </div>
          
          <!-- Shipping Information -->
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h3 style="color: #B1123B; margin-top: 0;">Shipping Information</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
              <div>
                <h4 style="color: #374151; margin-top: 0;">Delivery Address</h4>
                ${addressLines(order)}
              </div>
              <div>
                <h4 style="color: #374151; margin-top: 0;">Shipping Method</h4>
                ${order.shipping?.name ? `
                  <p style="margin: 5px 0;"><strong>Method:</strong> ${order.shipping.name}</p>
                  <p style="margin: 5px 0;"><strong>Cost:</strong> ${formatCurrency(order.shipping.charge)}</p>
                  <p style="margin: 5px 0;"><strong>Estimated Delivery:</strong> ${order.shipping.estimatedDays} days</p>
                ` : '<p style="margin: 5px 0; color: #666;">Standard shipping</p>'}
              </div>
            </div>
          </div>
          
          <!-- Processing Status -->
          <div style="background: #FDF2F5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h4 style="color: #8F0E2F; margin-top: 0;">What's happening now?</h4>
            <ul style="color: #8F0E2F;">
              <li>Your items are being carefully inspected</li>
              <li>Quality checks are being performed</li>
              <li>Packaging is being prepared</li>
              <li>Shipping labels are being generated</li>
            </ul>
            <p style="color: #8F0E2F; margin-top: 15px; font-weight: bold;">
              Estimated processing time: 1-2 business days
            </p>
          </div>

          <!-- Order Items Summary -->
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #B1123B; margin-top: 0;">Order Items Summary</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
              ${order.items.map(item => `
                <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px;">
                  <div style="width: 80px; height: 80px; background: #f3f4f6; border-radius: 8px; margin-bottom: 10px; display: flex; align-items: center; justify-content: center; border: 1px solid #e5e7eb;">
                    ${item.mainImage ? `<img src="${item.mainImage}" alt="${item.name}" style="width: 100%; height: 100%; object-fit: contain; border-radius: 8px; max-width: 100%; max-height: 100%;">` : '<span style="color: #9ca3af; font-size: 12px;">No Image</span>'}
                  </div>
                  <h4 style="margin: 0 0 5px 0; font-size: 14px; color: #374151;">${item.name}</h4>
                  <p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Qty: ${item.quantity}</p>
                  <p style="margin: 3px 0; font-size: 12px; color: #6b7280;">${formatCurrency(item.price)} each</p>
                  ${item.size ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">${item.measureType || 'Size'}: ${item.size} ${item.unitName || ''}</p>` : ''}
                  ${item.color ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Color: ${item.color}</p>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
          
          <p>We'll notify you again once your order is shipped with tracking information.</p>
          
          <!-- Order Tracking Link -->
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.CLIENT_URL}/profile/orders/${order.orderId}" 
               style="display: inline-block; background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
              📋 Track Order Status
            </a>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <p style="color: #B1123B; font-weight: bold;">Thank you for your patience!</p>
          </div>
        </div>
        
        <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666;">
          <p>${brandFooter()}</p>
          <p>This is an automated email. Please do not reply to this message.</p>
        </div>
      </div>
    `
  }),

  orderDelivered: (order, user) => ({
    subject: `Order Delivered - Order #${order.orderId}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
          <h1 style="margin: 0;">${BRAND.NAME}</h1>
          <p style="margin: 5px 0;">Premium Fashion & Lifestyle</p>
        </div>
        
        <div style="padding: 20px; background: #f8f9fa;">
          <h2 style="color: #B1123B;">Order Delivered Successfully!</h2>
          <p>Dear ${greetName(user, order)},</p>
          <p>🎉 Your order has been successfully delivered! We hope you love your new items.</p>
          
          <!-- Order Summary -->
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h3 style="color: #B1123B; margin-top: 0;">Order Details</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
              <div>
                <p><strong>Order ID:</strong> #${order.orderId}</p>
                <p><strong>Order Date:</strong> ${formatDate(order.createdAt)}</p>
                <p><strong>Status:</strong> <span style="color: #059669; font-weight: bold; text-transform: uppercase;">DELIVERED</span></p>
                <p><strong>Payment Status:</strong> <span style="color: ${order.paymentStatus === 'completed' ? '#059669' : '#B1123B'}; font-weight: bold; text-transform: uppercase;">${order.paymentStatus}</span></p>
              </div>
                             <div>
                 <p><strong>Payment Method:</strong> ${order.paymentMethod}</p>
                 <p><strong>Total Amount:</strong> ${formatCurrency(order.grandTotal)}</p>
                 <p><strong>Items Delivered:</strong> ${order.items.reduce((sum, item) => sum + item.quantity, 0)} items</p>
               </div>
            </div>
          </div>
          
          <!-- Delivery Information -->
          <div style="background: #FDF2F5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h4 style="color: #8F0E2F; margin-top: 0;">Delivery Information</h4>
            <p style="color: #8F0E2F; margin: 5px 0;"><strong>Delivered to:</strong> ${order.shippingAddress?.fullName || ''}</p>
            <p style="color: #8F0E2F; margin: 5px 0;"><strong>Address:</strong> ${[order.shippingAddress?.address, order.shippingAddress?.city, order.shippingAddress?.state, order.shippingAddress?.postalCode].filter(Boolean).join(', ')}</p>
            <p style="color: #8F0E2F; margin: 5px 0;"><strong>Phone:</strong> ${order.shippingAddress?.phone || ''}</p>
            ${order.shipping?.name ? `
              <p style="color: #8F0E2F; margin: 5px 0;"><strong>Shipping Method:</strong> ${order.shipping.name}</p>
              <p style="color: #8F0E2F; margin: 5px 0;"><strong>Shipping Cost:</strong> ${formatCurrency(order.shipping.charge)}</p>
            ` : ''}
            <p style="color: #8F0E2F; margin: 15px 0 0 0; font-weight: bold;">
              Delivery completed on: ${formatDate(new Date())}
            </p>
          </div>

          <!-- Order Items Summary -->
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #B1123B; margin-top: 0;">Delivered Items</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
              ${order.items.map(item => `
                <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px;">
                  <div style="width: 80px; height: 80px; background: #f3f4f6; border-radius: 8px; margin-bottom: 10px; display: flex; align-items: center; justify-content: center; border: 1px solid #e5e7eb;">
                    ${item.mainImage ? `<img src="${item.mainImage}" alt="${item.name}" style="width: 100%; height: 100%; object-fit: contain; border-radius: 8px; max-width: 100%; max-height: 100%;">` : '<span style="color: #9ca3af; font-size: 12px;">No Image</span>'}
                  </div>
                  <h4 style="margin: 0 0 5px 0; font-size: 14px; color: #374151;">${item.name}</h4>
                  <p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Qty: ${item.quantity}</p>
                  <p style="margin: 3px 0; font-size: 12px; color: #6b7280;">${formatCurrency(item.price)} each</p>
                  ${item.size ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">${item.measureType || 'Size'}: ${item.size} ${item.unitName || ''}</p>` : ''}
                  ${item.color ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Color: ${item.color}</p>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
          
          <!-- Next Steps -->
          <div style="background: #FDF2F5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h4 style="color: #B1123B; margin-top: 0;">What's next?</h4>
            <ul style="color: #B1123B;">
              <li>Please inspect your items upon delivery</li>
              <li>You have 7 days to return if needed</li>
              <li>Share your experience with us</li>
              <li>Consider leaving a review for your purchased items</li>
            </ul>
          </div>
          
          <!-- Quality Guarantee -->
          <div style="background: #FDF2F5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h4 style="color: #8F0E2F; margin-top: 0;">Quality Guarantee</h4>
            <p style="color: #8F0E2F; margin: 0;">All our products come with a quality guarantee. If you're not completely satisfied, please contact our customer service within 7 days.</p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <p style="color: #B1123B; font-weight: bold;">Thank you for choosing ${BRAND.NAME}!</p>
            <p style="color: #666;">We hope to see you again soon.</p>
          </div>
          
          <!-- Order Details Link -->
          <div style="text-align: center; margin: 20px 0;">
            <a href="${process.env.CLIENT_URL}/profile/orders/${order.orderId}" 
               style="display: inline-block; background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); color: white; padding: 12px 25px; text-decoration: none; border-radius: 6px; font-weight: bold; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
              📋 View Order Details
            </a>
          </div>
        </div>
        
        <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666;">
          <p>${brandFooter()}</p>
          <p>This is an automated email. Please do not reply to this message.</p>
        </div>
      </div>
    `
  }),

  orderShipped: (order, user) => ({
    subject: `Order Shipped - Order #${order.orderId}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
          <h1 style="margin: 0;">${BRAND.NAME}</h1>
          <p style="margin: 5px 0;">Premium Fashion & Lifestyle</p>
        </div>
        
        <div style="padding: 20px; background: #f8f9fa;">
          <h2 style="color: #B1123B;">Your Order is on the Way! 🚚</h2>
          <p>Dear ${greetName(user, order)},</p>
          <p>Great news! Your order has been shipped and is on its way to you.</p>
          
          <!-- Order Summary -->
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h3 style="color: #B1123B; margin-top: 0;">Order Details</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
              <div>
                <p><strong>Order ID:</strong> #${order.orderId}</p>
                <p><strong>Order Date:</strong> ${formatDate(order.createdAt)}</p>
                <p><strong>Status:</strong> <span style="color: #B1123B; font-weight: bold; text-transform: uppercase;">SHIPPED</span></p>
                <p><strong>Payment Status:</strong> <span style="color: ${order.paymentStatus === 'completed' ? '#059669' : '#B1123B'}; font-weight: bold; text-transform: uppercase;">${order.paymentStatus}</span></p>
              </div>
                             <div>
                 <p><strong>Payment Method:</strong> ${order.paymentMethod}</p>
                 <p><strong>Total Amount:</strong> ${formatCurrency(order.grandTotal)}</p>
                 <p><strong>Items Shipped:</strong> ${order.items.reduce((sum, item) => sum + item.quantity, 0)} items</p>
               </div>
            </div>
          </div>
          
          <!-- Shipping Information -->
          <div style="background: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h4 style="color: #8F0E2F; margin-top: 0;">Shipping Information</h4>
            <p style="color: #8F0E2F; margin: 5px 0;"><strong>Shipping to:</strong> ${order.shippingAddress?.fullName || ''}</p>
            <p style="color: #8F0E2F; margin: 5px 0;"><strong>Address:</strong> ${[order.shippingAddress?.address, order.shippingAddress?.city, order.shippingAddress?.state, order.shippingAddress?.postalCode].filter(Boolean).join(', ')}</p>
            <p style="color: #8F0E2F; margin: 5px 0;"><strong>Phone:</strong> ${order.shippingAddress?.phone || ''}</p>
            ${order.shipping?.name ? `
              <p style="color: #8F0E2F; margin: 5px 0;"><strong>Shipping Method:</strong> ${order.shipping.name}</p>
              <p style="color: #8F0E2F; margin: 5px 0;"><strong>Shipping Cost:</strong> ${formatCurrency(order.shipping.charge)}</p>
              <p style="color: #8F0E2F; margin: 5px 0;"><strong>Estimated Delivery:</strong> ${order.shipping.estimatedDays} days</p>
            ` : ''}
            <p style="color: #8F0E2F; margin: 15px 0 0 0; font-weight: bold;">
              Shipped on: ${formatDate(new Date())}
            </p>
          </div>

          <!-- Order Items Summary -->
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #B1123B; margin-top: 0;">Shipped Items</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
              ${order.items.map(item => `
                <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px;">
                  <div style="width: 80px; height: 80px; background: #f3f4f6; border-radius: 8px; margin-bottom: 10px; display: flex; align-items: center; justify-content: center; border: 1px solid #e5e7eb;">
                    ${item.mainImage ? `<img src="${item.mainImage}" alt="${item.name}" style="width: 100%; height: 100%; object-fit: contain; border-radius: 8px; max-width: 100%; max-height: 100%;">` : '<span style="color: #9ca3af; font-size: 12px;">No Image</span>'}
                  </div>
                  <h4 style="margin: 0 0 5px 0; font-size: 14px; color: #374151;">${item.name}</h4>
                  <p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Qty: ${item.quantity}</p>
                  <p style="margin: 3px 0; font-size: 12px; color: #6b7280;">${formatCurrency(item.price)} each</p>
                  ${item.size ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">${item.measureType || 'Size'}: ${item.size} ${item.unitName || ''}</p>` : ''}
                  ${item.color ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Color: ${item.color}</p>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
          
          <!-- Delivery Instructions -->
          <div style="background: #FDF2F5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h4 style="color: #B1123B; margin-top: 0;">Delivery Instructions</h4>
            <ul style="color: #B1123B;">
              <li>Please ensure someone is available to receive the package</li>
              <li>Have your ID ready for verification if required</li>
              <li>Inspect the package before signing</li>
              <li>Contact us immediately if there are any issues</li>
            </ul>
          </div>
          
          <!-- Tracking Information -->
          <div style="background: #FDF2F5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h4 style="color: #8F0E2F; margin-top: 0;">Track Your Order</h4>
            <p style="color: #8F0E2F; margin: 0;">You can track your order status by logging into your account or contacting our customer service.</p>
            <div style="text-align: center; margin-top: 15px;">
              <a href="${process.env.CLIENT_URL}/profile/orders/${order.orderId}" 
                 style="display: inline-block; background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); color: white; padding: 12px 25px; text-decoration: none; border-radius: 6px; font-weight: bold; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
                🚚 Track Order
              </a>
            </div>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <p style="color: #B1123B; font-weight: bold;">Your order is on its way!</p>
            <p style="color: #666;">We'll notify you once it's delivered.</p>
          </div>
        </div>
        
        <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666;">
          <p>${brandFooter()}</p>
          <p>This is an automated email. Please do not reply to this message.</p>
        </div>
      </div>
    `
  }),
  posOrderConfirmation: (posOrder) => ({
    subject: `Receipt - Order #${posOrder.orderNumber}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
          <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME}" style="width: 50px; height: 50px; object-fit: contain;">
          <h1 style="margin: 5px 0;">${BRAND.NAME}</h1>
          <p style="margin: 0;">POS Receipt</p>
        </div>
        <div style="padding: 20px; background: #f8f9fa;">
          <p>Dear ${posOrder.customer.name},</p>
          <p>Thank you for your purchase at ${BRAND.NAME}! Here is your receipt.</p>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h3 style="color: #8F0E2F; margin-top: 0;">Receipt Summary</h3>
            <p><strong>Order #:</strong> ${posOrder.orderNumber}</p>
            <p><strong>Date:</strong> ${formatDate(posOrder.createdAt)}</p>
            <p><strong>Payment:</strong> ${posOrder.paymentMethod}</p>
          </div>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: white; border-radius: 8px; overflow: hidden;">
            <thead>
              <tr style="background: #B1123B; color: white;">
                <th style="padding: 10px; text-align: left;">Item</th>
                <th style="padding: 10px; text-align: center;">Qty</th>
                <th style="padding: 10px; text-align: right;">Price</th>
                <th style="padding: 10px; text-align: right;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${posOrder.items.map(item => `
                <tr style="border-bottom: 1px solid #e5e7eb;">
                  <td style="padding: 10px;">
                    <strong>${item.productName}</strong>
                    ${item.variantInfo?.size ? `<br><span style="font-size: 12px; color: #666;">${item.variantInfo.measureType || 'Size'}: ${item.variantInfo.size}${item.variantInfo.unitName ? ' ' + item.variantInfo.unitName : ''}${item.variantInfo.color ? ', ' + item.variantInfo.color : ''}</span>` : ''}
                  </td>
                  <td style="padding: 10px; text-align: center;">${item.quantity}</td>
                  <td style="padding: 10px; text-align: right;">${formatCurrency(item.discountPrice || item.unitPrice)}</td>
                  <td style="padding: 10px; text-align: right;">${formatCurrency(item.totalPrice)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 14px;">
              <div><p><strong>Subtotal:</strong></p></div>
              <div style="text-align: right;"><p>${formatCurrency(posOrder.subtotal)}</p></div>
              ${posOrder.tax > 0 ? `<div><p><strong>Tax:</strong></p></div><div style="text-align: right;"><p>${formatCurrency(posOrder.tax)}</p></div>` : ''}
              ${posOrder.discount > 0 ? `<div><p><strong>Discount:</strong></p></div><div style="text-align: right;"><p>-${formatCurrency(posOrder.discount)}</p></div>` : ''}
          <div style="border-top: 2px solid #B1123B; padding-top: 10px;"><p><strong>Total:</strong></p></div>
          <div style="border-top: 2px solid #B1123B; padding-top: 10px; text-align: right;"><p><strong>${formatCurrency(posOrder.total)}</strong></p></div>
            </div>
          </div>
          <div style="text-align: center; margin: 20px 0;">
            <p style="color: #B1123B; font-weight: bold;">Thank you for shopping at ${BRAND.NAME}!</p>
            <p style="color: #666; font-size: 13px;">Visit us again at ${BRAND.SITE_HOST}</p>
          </div>
        </div>
        <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666;">
          <p>${brandFooter()}</p>
          <p>This is an automated receipt. Please do not reply.</p>
        </div>
      </div>
    `
  })
};

// Send email function
const sendEmail = async (to, template, data) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.log('⚠️ Email credentials not configured. Skipping email send.');
      return { success: false, message: 'Email credentials not configured' };
    }

    let emailContent;
    
    if (template === 'custom') {
      // For custom emails (like OTP)
      emailContent = {
        subject: data.customSubject,
        html: data.customHtml
      };
    } else if (template === 'email_update_otp') {
      // For email update OTP
      emailContent = {
        subject: `Email Update Verification - ${BRAND.NAME}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 30px; text-align: center; color: white; border-radius: 10px 10px 0 0;">
              <div style="display: flex; align-items: center; justify-content: center; gap: 15px; margin-bottom: 10px;">
                <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME} Logo" style="width: 60px; height: 60px; object-fit: contain;">
                <h1 style="margin: 0;">Email Update Verification</h1>
              </div>
              <p style="margin: 5px 0;">Verify your new email address</p>
            </div>
            
            <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
              <h2 style="color: #B1123B; margin-top: 0;">Email Update Request</h2>
              <p>Hello,</p>
              <p>We received a request to update your email address to: <strong>${data.newEmail}</strong></p>
              <p>To complete this process, please use the verification code below:</p>
              
              <div style="background: white; padding: 30px; border-radius: 8px; margin: 30px 0; text-align: center; border: 2px solid #B1123B;">
                <h1 style="color: #B1123B; font-size: 48px; letter-spacing: 8px; margin: 0; font-family: monospace;">${data.otp}</h1>
                <p style="color: #6b7280; margin-top: 10px;">Verification Code</p>
              </div>
              
              <div style="background: #FDF2F5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
                <h4 style="color: #8F0E2F; margin-top: 0;">Important Information</h4>
                <ul style="color: #8F0E2F;">
                  <li>This code will expire in 10 minutes</li>
                  <li>If you didn't request this change, please ignore this email</li>
                  <li>For security, you'll be logged out after updating your email</li>
                </ul>
              </div>
              
              <div style="text-align: center; margin: 30px 0;">
                <p style="color: #B1123B; font-weight: bold;">Thank you for choosing ${BRAND.NAME}!</p>
                <p style="color: #6b7280;">If you have any questions, please contact our support team.</p>
              </div>
            </div>
            
            <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666; border-radius: 10px; margin-top: 20px;">
              <p>${brandFooter()}</p>
              <p>This is an automated email. Please do not reply to this message.</p>
            </div>
          </div>
        `
      };
    } else {
      // For order emails
      emailContent = emailTemplates[template](data.order, data.user);
    }
    
    const mailOptions = {
      from: brandFrom(),
      to: to,
      subject: emailContent.subject,
      html: emailContent.html
    };

    const result = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent successfully to ${to}: ${template}`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    return { success: false, error: error.message, message: error.message };
  }
};

// Send a free-form email (admin replies, custom notices) through the server email account
const sendCustomEmail = async ({ to, subject, html, text }) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.log('⚠️ Email credentials not configured. Skipping email send.');
      return { success: false, message: 'Email credentials not configured' };
    }
    if (!to || !subject) {
      return { success: false, message: 'Recipient and subject are required' };
    }

    const mailOptions = {
      from: brandFrom(),
      to,
      subject,
      html,
      text
    };

    const result = await transporter.sendMail(mailOptions);
    console.log(`✅ Custom email sent to ${to}: ${subject}`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error(`❌ Failed to send custom email to ${to}:`, error.message);
    return { success: false, error: error.message, message: error.message };
  }
};

// Send order confirmation email
const sendOrderConfirmation = async (order, user) => {
  return await sendEmail(user.email, 'orderConfirmation', { order, user });
};

// Send order processing email
const sendOrderProcessing = async (order, user) => {
  return await sendEmail(user.email, 'orderProcessing', { order, user });
};

// Send order shipped email
const sendOrderShipped = async (order, user) => {
  return await sendEmail(user.email, 'orderShipped', { order, user });
};

// Send order delivered email
const sendOrderDelivered = async (order, user) => {
  return await sendEmail(user.email, 'orderDelivered', { order, user });
};

const sendOrderCancelled = async (order, user) => {
  try {
    if (!user?.email) return { success: false, message: 'No recipient email for cancelled order' };
    const subject = `Order #${order.orderId} Cancelled`;
    
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Order Cancelled</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #B1123B, #8F0E2F); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
          .order-details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B; }
          .item { display: flex; gap: 15px; padding: 15px 0; border-bottom: 1px solid #eee; }
          .item:last-child { border-bottom: none; }
          .item-image { width: 80px; height: 80px; background: #f3f4f6; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid #e5e7eb; }
          .item-image img { width: 100%; height: 100%; object-fit: contain; border-radius: 8px; max-width: 100%; max-height: 100%; }
          .item-details { flex: 1; }
          .item-name { font-weight: bold; margin-bottom: 5px; }
          .item-meta { color: #666; font-size: 14px; }
          .totals { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .total-row { display: flex; justify-content: space-between; margin: 10px 0; }
          .total-row.final { font-weight: bold; font-size: 18px; border-top: 2px solid #eee; padding-top: 10px; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
          .cancellation-notice { background: #FDF2F5; border: 1px solid #F3C6D3; padding: 15px; border-radius: 8px; margin: 20px 0; }
          .cancellation-notice h3 { color: #8F0E2F; margin: 0 0 10px 0; }
          .cancellation-notice p { color: #8F0E2F; margin: 0; }
        </style>
      </head>
      <body>
        <div class="container">
                     <div class="header">
             <div style="display: flex; align-items: center; justify-content: center; gap: 15px; margin-bottom: 10px;">
               <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME} Logo" style="width: 60px; height: 60px; object-fit: contain;">
               <h1 style="margin: 0;">Order Cancelled</h1>
             </div>
             <p>We're sorry to inform you that your order has been cancelled</p>
           </div>
          
          <div class="content">
            <div class="cancellation-notice">
              <h3>⚠️ Order Cancellation Notice</h3>
              <p>Your order #${order.orderId} has been cancelled. If you have any questions about this cancellation, please contact our customer support team.</p>
            </div>
            
            <div class="order-details">
              <h2>Order Details</h2>
              <p><strong>Order ID:</strong> #${order.orderId}</p>
              <p><strong>Order Date:</strong> ${formatDate(order.createdAt)}</p>
              <p><strong>Status:</strong> <span style="color: #B1123B; font-weight: bold;">Cancelled</span></p>
              <p><strong>Customer:</strong> ${user.fullName}</p>
              <p><strong>Email:</strong> ${user.email}</p>
            </div>
            
            <div class="order-details">
              <h3>Order Items</h3>
              ${order.items.map(item => `
                <div class="item">
                  <div class="item-image">
                    ${item.mainImage ? `<img src="${item.mainImage}" alt="${item.name}">` : '<span style="color: #9ca3af;">No Image</span>'}
                  </div>
                  <div class="item-details">
                    <div class="item-name">${item.name}</div>
                    <div class="item-meta">
                       ${item.color ? `Color: ${item.color}<br>` : ''}
                        ${item.size ? `${item.measureType || 'Size'}: ${item.size} ${item.unitName || ''}<br>` : ''}
                       Quantity: ${item.quantity}<br>
                       Price: ${formatCurrency(item.price)}
                       ${item.discountApplied > 0 ? `<br>Discount: ${formatCurrency(item.discountApplied)}` : ''}
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
            
            <div class="totals">
              <h3>Order Summary</h3>
              <div class="total-row">
                <span>Subtotal:</span>
                <span>${formatCurrency(order.totalAmount)}</span>
              </div>
              ${order.discountAmount > 0 ? `
                <div class="total-row">
                  <span>Discount:</span>
                  <span style="color: #10b981;">-${formatCurrency(order.discountAmount)}</span>
                </div>
              ` : ''}
              <div class="total-row">
                <span>Shipping:</span>
                <span>${formatCurrency(order.shippingCost || 0)}</span>
              </div>
              ${order.extraFeeTotal > 0 ? `
                <div class="total-row">
                  <span>Extra Fees:</span>
                  <span>${formatCurrency(order.extraFeeTotal)}</span>
                </div>
              ` : ''}
              <div class="total-row final">
                <span>Total:</span>
                <span>${formatCurrency(order.grandTotal)}</span>
              </div>
            </div>
            
            <div class="order-details">
              <h3>Shipping Information</h3>
              <p><strong>Address:</strong></p>
              <p>${order.shippingAddress?.fullName || ''}<br>
              ${order.shippingAddress?.address || ''}<br>
              ${[order.shippingAddress?.city, order.shippingAddress?.state, order.shippingAddress?.postalCode].filter(Boolean).join(', ')}<br>
              ${order.shippingAddress?.country || ''}<br>
              Phone: ${order.shippingAddress?.phone || ''}</p>
              
              ${order.shipping ? `
                <p><strong>Shipping Method:</strong> ${order.shipping.name}</p>
                <p><strong>Shipping Cost:</strong> ${formatCurrency(order.shipping.charge)}</p>
                <p><strong>Estimated Delivery:</strong> ${order.shipping.estimatedDays} days</p>
              ` : ''}
            </div>
            
            <div class="order-details">
              <h3>Payment Information</h3>
              <p><strong>Payment Method:</strong> ${order.paymentMethod}</p>
              <p><strong>Payment Status:</strong> ${order.paymentStatus}</p>
            </div>
            
            <div class="footer">
              <p>If you have any questions about this cancellation, please don't hesitate to contact us.</p>
              <p>Thank you for your understanding.</p>
            </div>
            
            <!-- Order Details Link -->
            <div style="text-align: center; margin: 20px 0;">
              <a href="${process.env.CLIENT_URL}/profile/orders/${order.orderId}" 
                 style="display: inline-block; background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); color: white; padding: 12px 25px; text-decoration: none; border-radius: 6px; font-weight: bold; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
                📋 View Order Details
              </a>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const result = await transporter.sendMail({
      from: brandFrom(),
      to: user.email,
      subject: subject,
      html: html
    });

    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('Error sending order cancelled email:', error);
    return { success: false, message: error.message };
  }
};

// Send order finalization email
const sendOrderFinalization = async (order, user) => {
  try {
    if (!user?.email) return { success: false, message: 'No recipient email for finalized order' };
    const subject = `Order Finalized - Order #${order.orderId}`;
    
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Order Finalized</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #B1123B, #8F0E2F); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
          .order-details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B; }
          .item { display: flex; gap: 15px; padding: 15px 0; border-bottom: 1px solid #eee; }
          .item:last-child { border-bottom: none; }
          .item-image { width: 80px; height: 80px; background: #f3f4f6; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid #e5e7eb; }
          .item-image img { width: 100%; height: 100%; object-fit: contain; border-radius: 8px; max-width: 100%; max-height: 100%; }
          .item-details { flex: 1; }
          .item-name { font-weight: bold; margin-bottom: 5px; }
          .item-meta { color: #666; font-size: 14px; }
          .totals { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .total-row { display: flex; justify-content: space-between; margin: 10px 0; }
          .total-row.final { font-weight: bold; font-size: 18px; border-top: 2px solid #eee; padding-top: 10px; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
          .finalization-notice { background: #FDF2F5; border: 1px solid #F3C6D3; padding: 15px; border-radius: 8px; margin: 20px 0; }
          .finalization-notice h3 { color: #8F0E2F; margin: 0 0 10px 0; }
          .finalization-notice p { color: #8F0E2F; margin: 0; }
        </style>
      </head>
      <body>
        <div class="container">
                     <div class="header">
             <div style="display: flex; align-items: center; justify-content: center; gap: 15px; margin-bottom: 10px;">
               <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME} Logo" style="width: 60px; height: 60px; object-fit: contain;">
               <h1 style="margin: 0;">Order Finalized</h1>
             </div>
             <p>Your order has been finalized and is ready for processing</p>
           </div>
          
          <div class="content">
            <div class="finalization-notice">
              <h3>✅ Order Finalization Notice</h3>
              <p>Your order #${order.orderId} has been finalized by our admin team. The order is now confirmed and will be processed for delivery.</p>
            </div>
            
            <div class="order-details">
              <h2>Order Details</h2>
              <p><strong>Order ID:</strong> #${order.orderId}</p>
              <p><strong>Order Date:</strong> ${formatDate(order.createdAt)}</p>
              <p><strong>Status:</strong> <span style="color: #059669; font-weight: bold;">Finalized</span></p>
              <p><strong>Customer:</strong> ${user.fullName}</p>
              <p><strong>Email:</strong> ${user.email}</p>
            </div>
            
            <div class="order-details">
              <h3>Order Items</h3>
              ${order.items.map(item => `
                <div class="item">
                  <div class="item-image">
                    ${item.mainImage ? `<img src="${item.mainImage}" alt="${item.name}">` : '<span style="color: #9ca3af;">No Image</span>'}
                  </div>
                  <div class="item-details">
                    <div class="item-name">${item.name}</div>
                    <div class="item-meta">
                       ${item.color ? `Color: ${item.color}<br>` : ''}
                        ${item.size ? `${item.measureType || 'Size'}: ${item.size} ${item.unitName || ''}<br>` : ''}
                       Quantity: ${item.quantity}<br>
                       Price: ${formatCurrency(item.price)}
                       ${item.discountApplied > 0 ? `<br>Discount: ${formatCurrency(item.discountApplied)}` : ''}
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
            
            <div class="totals">
              <h3>Order Summary</h3>
              <div class="total-row">
                <span>Subtotal:</span>
                <span>${formatCurrency(order.totalAmount)}</span>
              </div>
              ${order.discountAmount > 0 ? `
                <div class="total-row">
                  <span>Discount:</span>
                  <span style="color: #10b981;">-${formatCurrency(order.discountAmount)}</span>
                </div>
              ` : ''}
              <div class="total-row">
                <span>Shipping:</span>
                <span>${formatCurrency(order.shippingCost || 0)}</span>
              </div>
              ${order.extraFeeTotal > 0 ? `
                <div class="total-row">
                  <span>Extra Fees:</span>
                  <span>${formatCurrency(order.extraFeeTotal)}</span>
                </div>
              ` : ''}
              <div class="total-row final">
                <span>Grand Total:</span>
                <span>${formatCurrency(order.grandTotal)}</span>
              </div>
            </div>
            
            <div class="order-details">
              <h3>Shipping Information</h3>
              <p><strong>Address:</strong></p>
              <p>${order.shippingAddress?.fullName || ''}<br>
              ${order.shippingAddress?.address || ''}<br>
              ${[order.shippingAddress?.city, order.shippingAddress?.state, order.shippingAddress?.postalCode].filter(Boolean).join(', ')}<br>
              ${order.shippingAddress?.country || ''}<br>
              Phone: ${order.shippingAddress?.phone || ''}</p>
              
              ${order.shipping ? `
                <p><strong>Shipping Method:</strong> ${order.shipping.name}</p>
                <p><strong>Shipping Cost:</strong> ${formatCurrency(order.shipping.charge)}</p>
                <p><strong>Estimated Delivery:</strong> ${order.shipping.estimatedDays} days</p>
              ` : ''}
            </div>
            
            <div class="order-details">
              <h3>Payment Information</h3>
              <p><strong>Payment Method:</strong> ${order.paymentMethod}</p>
              <p><strong>Payment Status:</strong> ${order.paymentStatus}</p>
            </div>
            
            <div class="footer">
              <p>Your order is now finalized and will be processed for delivery. We'll keep you updated on the progress.</p>
              <p>Thank you for choosing ${BRAND.NAME}!</p>
            </div>
            
            <!-- Order Details Link -->
            <div style="text-align: center; margin: 20px 0;">
              <a href="${process.env.CLIENT_URL}/profile/orders/${order.orderId}" 
                 style="display: inline-block; background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); color: white; padding: 12px 25px; text-decoration: none; border-radius: 6px; font-weight: bold; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
                📋 View Order Details
              </a>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const result = await transporter.sendMail({
      from: brandFrom(),
      to: user.email,
      subject: subject,
      html: html
    });

    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('Error sending order finalization email:', error);
    return { success: false, message: error.message };
  }
};

const sendPOSReceipt = async (posOrder) => {
  if (!posOrder.customer?.email) {
    console.log('⚠️ No customer email for POS order', posOrder.orderNumber);
    return { success: false, message: 'No customer email' };
  }
  return await sendEmail(posOrder.customer.email, 'posOrderConfirmation', { order: posOrder, user: null });
};

// Send login credentials (email + password) to a newly created user or admin
const sendAccountCredentials = async ({ to, name, email, password, role = 'customer', loginUrl }) => {
  const url = loginUrl || process.env.CLIENT_URL || `https://${BRAND.SITE_HOST}`;
  const roleLabel = role === 'admin' ? 'Administrator' : 'Customer';
  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #1B1B1B;">
      <div style="background: #B1123B; padding: 24px; text-align: center;">
        <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME}" style="width: 56px; height: 56px; object-fit: contain;">
        <h1 style="margin: 8px 0 0; font-size: 22px; letter-spacing: 4px; color: #fff;">${BRAND.NAME}</h1>
      </div>
      <div style="border: 1px solid #eee; border-top: none; padding: 28px 24px;">
        <h2 style="margin: 0 0 12px; font-size: 18px;">Your ${BRAND.NAME} account is ready</h2>
        <p style="margin: 0 0 16px; line-height: 1.6;">
          Hi ${name || 'there'},<br/>
          An account has been created for you as a <strong>${roleLabel}</strong>. Here are your login credentials:
        </p>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <tr>
            <td style="padding: 10px 12px; background: #f7f5f3; border: 1px solid #eee; font-size: 13px; color: #666; width: 40%;">Email</td>
            <td style="padding: 10px 12px; border: 1px solid #eee; font-size: 14px; font-weight: bold;">${email || to}</td>
          </tr>
          <tr>
            <td style="padding: 10px 12px; background: #f7f5f3; border: 1px solid #eee; font-size: 13px; color: #666;">Password</td>
            <td style="padding: 10px 12px; border: 1px solid #eee; font-size: 14px; font-weight: bold;">${password}</td>
          </tr>
        </table>
        <div style="text-align: center; margin: 20px 0;">
          <a href="${url}"
             style="display: inline-block; background: #B1123B; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 4px; font-weight: bold; letter-spacing: 1px;">
            LOG IN NOW
          </a>
        </div>
        <p style="font-size: 12px; color: #888; line-height: 1.6;">
          For your security, we recommend changing your password after your first sign-in.
        </p>
      </div>
      <div style="padding: 16px 24px; text-align: center; font-size: 12px; color: #888; border-top: 1px solid #eee;">
        <p>${brandFooter()}</p>
        <p>This is an automated email. Please do not reply to this message.</p>
      </div>
    </div>
  `;
  return await sendCustomEmail({
    to,
    subject: `Your ${BRAND.NAME} Account Credentials`,
    html,
    text: `Hi ${name || 'there'}, your ${BRAND.NAME} account is ready. Email: ${email || to} | Password: ${password}`
  });
};

module.exports = {
  sendEmail,
  sendCustomEmail,
  sendAccountCredentials,
  sendOrderConfirmation,
  sendOrderProcessing,
  sendOrderShipped,
  sendOrderDelivered,
  sendOrderCancelled,
  sendOrderFinalization,
  sendPOSReceipt
};
