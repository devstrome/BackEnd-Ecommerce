const nodemailer = require('nodemailer');
const { BRAND, brandFrom, brandFooter, publicSiteUrl } = require('./brand');
const { formatMeasureParts, formatMeasureText } = require('./measure');

// Email configuration
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

const addBrandLogoToEmailHtml = (html) => {
  if (!html) return html;
  const content = String(html);
  if (content.includes(BRAND.LOGO_URL)) return content;

  const logoHeader = `<table role="presentation" width="100%" style="border-collapse:collapse"><tr><td align="center" style="padding:16px 12px"><img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME}" width="76" height="76" style="display:block;width:76px;height:76px;object-fit:contain;margin:0 auto;border:0"></td></tr></table>`;
  const bodyOpening = /<body\b[^>]*>/i;
  if (bodyOpening.test(content)) {
    return content.replace(bodyOpening, (opening) => `${opening}${logoHeader}`);
  }
  return `${logoHeader}${content}`;
};

const replaceLocalStorefrontUrls = (content) => {
  if (typeof content !== 'string' || !content) return content;
  // Custom notices and newsletters can contain links authored outside the
  // standard templates, so canonicalize the local storefront origin centrally.
  return content.replace(
    /(?:(?:https?:)?\/\/)?(?:localhost|127\.0\.0\.1):3001\b/gi,
    'https://belorella.com'
  );
};

const sendBrandedEmail = (mailOptions) => transporter.sendMail({
  ...mailOptions,
  html: addBrandLogoToEmailHtml(replaceLocalStorefrontUrls(mailOptions.html)),
  text: replaceLocalStorefrontUrls(mailOptions.text),
});

// Superadmins receive a hidden copy of operational notifications. Resolve the
// recipients at send time so newly-created or banned admins are respected.
const getSuperAdminEmails = async () => {
  try {
    const Admin = require('../models/Admin');
    const admins = await Admin.find({ superAdmin: true, banned: { $ne: true } })
      .select('email')
      .lean();
    return [...new Set((admins || [])
      .map((admin) => String(admin.email || '').trim().toLowerCase())
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
  } catch (error) {
    console.error('Unable to load superadmin notification recipients:', error.message);
    return [];
  }
};

const addSuperAdminBcc = async (mailOptions, excludedRecipients = []) => {
  const excluded = new Set(excludedRecipients
    .flatMap((recipient) => String(recipient || '').split(','))
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean));
  const existingBcc = Array.isArray(mailOptions.bcc)
    ? mailOptions.bcc
    : String(mailOptions.bcc || '').split(',');
  const existing = new Set(existingBcc.map((email) => String(email).trim().toLowerCase()).filter(Boolean));
  const recipients = (await getSuperAdminEmails())
    .filter((email) => !excluded.has(email) && !existing.has(email));
  if (recipients.length) mailOptions.bcc = [...existingBcc.filter(Boolean), ...recipients];
  return mailOptions;
};

const sendSuperAdminNotification = async ({ subject, html, text }) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      return { success: false, message: 'Email credentials not configured' };
    }
    const recipients = await getSuperAdminEmails();
    if (!recipients.length) {
      return { success: false, message: 'No active superadmin email recipients found' };
    }
    const senderMailbox = String(process.env.EMAIL_USER).trim().toLowerCase();
    const result = await sendBrandedEmail({
      from: brandFrom(),
      to: process.env.EMAIL_USER,
      bcc: recipients.filter((email) => email !== senderMailbox),
      subject,
      html,
      text,
    });
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('Failed to send superadmin notification:', error.message);
    return { success: false, error: error.message, message: error.message };
  }
};

// Helper function to format currency
const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-BD', {
    style: 'currency',
    currency: 'BDT',
    minimumFractionDigits: 2
  }).format(amount);
};

const sendAdminOrderNotification = async (order, user = {}, event = 'new_order') => {
  const eventLabels = {
    new_order: 'New online order',
    processing: 'Order moved to processing',
    shipped: 'Order shipped',
    delivered: 'Order delivered',
    cancelled: 'Order cancelled',
    finalized: 'Order finalized',
    status_updated: 'Order status updated',
    payment_status_updated: 'Payment status updated',
  };
  const label = eventLabels[event] || eventLabels.status_updated;
  const orderNumber = String(order?.orderId || order?._id || '');
  const safeOrderNumber = escapeEmailHtml(orderNumber);
  const safeName = escapeEmailHtml(user?.fullName || order?.shippingAddress?.fullName || 'Customer');
  const safeEmail = escapeEmailHtml(user?.email || 'Not provided');
  const safePhone = escapeEmailHtml(order?.shippingAddress?.phone || 'Not provided');
  const itemRows = (order?.items || []).map((item) => {
    const variant = [item.color, formatMeasureText(item)].filter(Boolean).join(' · ');
    return `<tr><td style="padding:9px;border-bottom:1px solid #eee">${escapeEmailHtml(item.name || 'Product')}${variant ? `<br><span style="color:#666;font-size:12px">${escapeEmailHtml(variant)}</span>` : ''}</td><td style="padding:9px;border-bottom:1px solid #eee;text-align:center">${Math.max(0, Number(item.quantity) || 0)}</td><td style="padding:9px;border-bottom:1px solid #eee;text-align:right">${formatCurrency((Number(item.price) || 0) * (Number(item.quantity) || 0))}</td></tr>`;
  }).join('');
  const dashboardUrl = publicSiteUrl('/admin/dashboard/orders');
  const amountDue = Number.isFinite(Number(order?.amountDue))
    ? Number(order.amountDue)
    : Math.max(0, Number(order?.grandTotal || order?.totalAmount || 0) - Number(order?.loyaltyAmountUsed || 0));
  const html = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#222"><header style="padding:20px;background:#8F0E2F;color:#fff"><h1 style="font-size:20px;margin:0">${BRAND.NAME} · Admin order alert</h1><p style="margin:7px 0 0">${escapeEmailHtml(label)} · #${safeOrderNumber}</p></header><main style="padding:22px;border:1px solid #eee"><h2 style="margin:0 0 12px;font-size:18px">Customer and order details</h2><p style="margin:5px 0"><strong>Customer:</strong> ${safeName}</p><p style="margin:5px 0"><strong>Email:</strong> ${safeEmail}</p><p style="margin:5px 0"><strong>Phone:</strong> ${safePhone}</p><p style="margin:5px 0"><strong>Order status:</strong> ${escapeEmailHtml(order?.orderStatus || 'pending')}</p><p style="margin:5px 0"><strong>Payment:</strong> ${escapeEmailHtml(order?.paymentMethod || '—')} · ${escapeEmailHtml(order?.paymentStatus || 'pending')}</p><table role="presentation" style="width:100%;border-collapse:collapse;margin:18px 0"><thead><tr style="text-align:left;background:#f8f8f8"><th style="padding:9px">Item</th><th style="padding:9px;text-align:center">Qty</th><th style="padding:9px;text-align:right">Total</th></tr></thead><tbody>${itemRows || '<tr><td colspan="3" style="padding:9px">No order items</td></tr>'}</tbody></table><p><strong>Subtotal:</strong> ${formatCurrency(order?.totalAmount || 0)}</p><p><strong>Shipping:</strong> ${formatCurrency(order?.shippingCost || 0)}</p><p><strong>Amount due:</strong> ${formatCurrency(amountDue)}</p><p><strong>Delivery address:</strong> ${escapeEmailHtml([order?.shippingAddress?.address, order?.shippingAddress?.city, order?.shippingAddress?.state, order?.shippingAddress?.postalCode, order?.shippingAddress?.country].filter(Boolean).join(', ') || 'Not provided')}</p><p style="margin-top:22px"><a href="${escapeEmailHtml(dashboardUrl)}" style="display:inline-block;padding:11px 18px;background:#B1123B;color:#fff;text-decoration:none;border-radius:5px">Open order dashboard</a></p><p style="font-size:12px;color:#777">This admin summary does not include transaction secrets or digital access credentials.</p></main></div>`;
  const textItems = (order?.items || []).map((item) => `${item.name || 'Product'} × ${item.quantity} — ${formatCurrency((Number(item.price) || 0) * (Number(item.quantity) || 0))}`).join('\n');
  return sendSuperAdminNotification({
    subject: `[${BRAND.NAME}] ${label} #${orderNumber}`,
    html,
    text: `${label} #${orderNumber}\nCustomer: ${user?.fullName || order?.shippingAddress?.fullName || 'Customer'}\nEmail: ${user?.email || 'Not provided'}\nPhone: ${order?.shippingAddress?.phone || 'Not provided'}\nStatus: ${order?.orderStatus || 'pending'}\nPayment: ${order?.paymentMethod || '—'} / ${order?.paymentStatus || 'pending'}\n${textItems}\nAmount due: ${formatCurrency(amountDue)}\n${dashboardUrl}`,
  });
};

const loyaltySummaryHtml = (order = {}) => {
  const used = Math.max(0, Number(order.loyaltyAmountUsed) || 0);
  const earned = Math.max(0, Number(order.loyaltyRewardEarned) || 0);
  const amountDue = Number.isFinite(Number(order.amountDue))
    ? Number(order.amountDue)
    : Math.max(0, (Number(order.grandTotal) || 0) - used);
  return [
    used > 0 ? `<p><strong>Loyalty balance applied:</strong> -${formatCurrency(used)}</p><p><strong>Amount due:</strong> ${formatCurrency(amountDue)}</p>` : '',
    earned > 0 ? `<p><strong>Loyalty earned:</strong> ${formatCurrency(earned)} added to your balance.</p>` : '',
  ].join('');
};

const orderAmountDue = (order = {}) => {
  const grandTotal = Number(order.grandTotal) || 0;
  const used = Math.max(0, Number(order.loyaltyAmountUsed) || 0);
  if (used <= 0) return grandTotal;
  return Number.isFinite(Number(order.amountDue)) ? Number(order.amountDue) : Math.max(0, grandTotal - used);
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

const escapeEmailHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const formatMeasureHtml = (item) => {
  const { label, value } = formatMeasureParts(item);
  return value ? `<strong>${escapeEmailHtml(label)}:</strong> ${escapeEmailHtml(value)}` : '';
};

const formatPreOrderLabel = (item) => {
  if (!item?.isPreOrder) return '';
  const date = item.preOrderEstimatedDate ? new Date(item.preOrderEstimatedDate) : null;
  const eta = date && !Number.isNaN(date.getTime()) ? ` · Estimated ${date.toLocaleDateString('en-BD')}` : ' · ETA to be confirmed';
  return `Pre-order${eta}`;
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

const invoiceBrandAssetsEmailBlock = () => `
  <table role="presentation" style="width:100%;border-collapse:collapse;margin-top:24px;border-top:1px solid #eee">
    <tr>
      <td style="width:50%;padding:16px 8px;text-align:center;vertical-align:bottom">
        <img src="${BRAND.SIGNATURE_URL}" alt="Authorized signature" style="display:block;width:130px;height:64px;object-fit:contain;margin:0 auto 6px">
        <div style="font-size:10px;color:#666">Authorized Signature</div>
      </td>
      <td style="width:50%;padding:16px 8px;text-align:center;vertical-align:bottom">
        <img src="${BRAND.SEAL_URL}" alt="BELORELLA company seal" style="display:block;width:76px;height:76px;object-fit:contain;margin:0 auto 2px">
        <div style="font-size:10px;color:#666">Company Seal</div>
      </td>
    </tr>
  </table>`;

// Email templates
const emailTemplates = {
  orderConfirmation: (order, user) => ({
    subject: `Order Confirmation - Order #${order.orderId}`,
    html: `
             <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
         <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
           <div style="display: flex; align-items: center; justify-content: center; gap: 15px; margin-bottom: 10px;">
             <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME} Logo" style="width: 60px; height: 60px; padding: 3px; box-sizing: border-box; border-radius: 12px; background-color: #fff; object-fit: contain;">
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
                  ${loyaltySummaryHtml(order)}
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
                         ${formatMeasureHtml(item) ? `<p style="margin: 3px 0;">${formatMeasureHtml(item)}</p>` : ''}
                         ${formatPreOrderLabel(item) ? `<p style="margin: 3px 0; color: #B1123B; font-weight: 600;">${escapeEmailHtml(formatPreOrderLabel(item))}</p>` : ''}
                         ${item.color ? `<p style="margin: 3px 0;"><strong>Color:</strong> ${item.color}</p>` : ''}
                         ${(item.regionName || item.configuration?.regionName || item.regionId?.name) ? `<p style="margin: 3px 0;"><strong>Region:</strong> ${item.regionName || item.configuration?.regionName || item.regionId.name}</p>` : ''}
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
                  ${loyaltySummaryHtml(order)}
                </div>
              </div>
            </div>
          
          <p>We'll keep you updated on the status of your order. You can track your order by logging into your account.</p>
          
          <!-- Order Tracking Link -->
          <div style="text-align: center; margin: 30px 0;">
            <a href="${publicSiteUrl(`/profile/orders/${encodeURIComponent(order.orderId)}`)}"
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
             <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME} Logo" style="width: 60px; height: 60px; padding: 3px; box-sizing: border-box; border-radius: 12px; background-color: #fff; object-fit: contain;">
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
                 <p><strong>Amount Due:</strong> ${formatCurrency(orderAmountDue(order))}</p>
                 ${loyaltySummaryHtml(order)}
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
                  ${formatMeasureHtml(item) ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">${formatMeasureHtml(item)}</p>` : ''}
                  ${formatPreOrderLabel(item) ? `<p style="margin: 3px 0; font-size: 12px; color: #B1123B; font-weight: 600;">${escapeEmailHtml(formatPreOrderLabel(item))}</p>` : ''}
                  ${item.color ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Color: ${item.color}</p>` : ''}
                  ${(item.regionName || item.configuration?.regionName || item.regionId?.name) ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Region: ${item.regionName || item.configuration?.regionName || item.regionId.name}</p>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
          
          <p>We'll notify you again once your order is shipped with tracking information.</p>
          
          <!-- Order Tracking Link -->
          <div style="text-align: center; margin: 30px 0;">
            <a href="${publicSiteUrl(`/profile/orders/${encodeURIComponent(order.orderId)}`)}"
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
                 <p><strong>Amount Due:</strong> ${formatCurrency(orderAmountDue(order))}</p>
                 ${loyaltySummaryHtml(order)}
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
                  ${formatMeasureHtml(item) ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">${formatMeasureHtml(item)}</p>` : ''}
                  ${formatPreOrderLabel(item) ? `<p style="margin: 3px 0; font-size: 12px; color: #B1123B; font-weight: 600;">${escapeEmailHtml(formatPreOrderLabel(item))}</p>` : ''}
                  ${item.color ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Color: ${item.color}</p>` : ''}
                  ${(item.regionName || item.configuration?.regionName || item.regionId?.name) ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Region: ${item.regionName || item.configuration?.regionName || item.regionId.name}</p>` : ''}
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
            <a href="${publicSiteUrl(`/profile/orders/${encodeURIComponent(order.orderId)}`)}"
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
                 <p><strong>Amount Due:</strong> ${formatCurrency(orderAmountDue(order))}</p>
                 ${loyaltySummaryHtml(order)}
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
                  ${formatMeasureHtml(item) ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">${formatMeasureHtml(item)}</p>` : ''}
                  ${formatPreOrderLabel(item) ? `<p style="margin: 3px 0; font-size: 12px; color: #B1123B; font-weight: 600;">${escapeEmailHtml(formatPreOrderLabel(item))}</p>` : ''}
                  ${item.color ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Color: ${item.color}</p>` : ''}
                  ${(item.regionName || item.configuration?.regionName || item.regionId?.name) ? `<p style="margin: 3px 0; font-size: 12px; color: #6b7280;">Region: ${item.regionName || item.configuration?.regionName || item.regionId.name}</p>` : ''}
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
              <a href="${publicSiteUrl(`/profile/orders/${encodeURIComponent(order.orderId)}`)}"
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
  posOrderConfirmation: (posOrder) => {
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const formatMeasure = formatMeasureText;
    const loyaltyUsed = Number(posOrder.loyaltyAmountUsed) || 0;
    const giftUsed = Number(posOrder.giftCodeAmountUsed) || 0;
    const hasAppliedBalance = loyaltyUsed > 0 || giftUsed > 0;
    const giftRows = (posOrder.giftCodeRedemptions || []).filter((entry) => Number(entry.appliedBDT) > 0).map((entry) =>
      `<div><p><strong>Gift code ••••-${escapeHtml(entry.codeSuffix)}:</strong></p></div><div style="text-align:right"><p>-${formatCurrency(entry.appliedBDT)}</p></div>`
    ).join('');
    const rows = (posOrder.items || []).map((item) => {
      const variant = item.variantInfo || {};
      const detailParts = [
        formatMeasure(variant),
        variant.color ? `Color: ${variant.color}` : '',
        variant.regionName ? `Region: ${variant.regionName}` : '',
        item.sku || variant.sku ? `SKU: ${item.sku || variant.sku}` : '',
        variant.barcode || item.scannedBarcode ? `My barcode: ${variant.barcode || item.scannedBarcode}` : '',
        variant.realBarcode ? `Product barcode: ${variant.realBarcode}` : '',
      ].filter(Boolean);
      const unitPrice = Number(item.discountPrice) > 0 ? Number(item.discountPrice) : Number(item.unitPrice) || 0;
      const qty = Math.max(1, Number(item.quantity) || 1);
      const totalPrice = Number.isFinite(Number(item.totalPrice)) ? Number(item.totalPrice) : unitPrice * qty;
      const image = variant.imageUrl || '';
      return `
        <tr style="border-bottom:1px solid #e5e7eb">
          <td style="padding:10px;vertical-align:top">
            ${image ? `<img src="${escapeHtml(image)}" alt="" width="54" height="54" style="display:block;width:54px;height:54px;object-fit:contain;border:1px solid #eee;margin-bottom:6px">` : ''}
            <strong>${escapeHtml(item.productName || 'Product')}</strong>
            ${detailParts.length ? `<br><span style="font-size:12px;line-height:1.6;color:#666">${detailParts.map(escapeHtml).join('<br>')}</span>` : ''}
          </td>
          <td style="padding:10px;text-align:center;vertical-align:top">${qty}</td>
          <td style="padding:10px;text-align:right;vertical-align:top">${formatCurrency(unitPrice)}</td>
          <td style="padding:10px;text-align:right;vertical-align:top">${formatCurrency(totalPrice)}</td>
        </tr>`;
    }).join('');

    return {
    subject: `Receipt - Order #${escapeHtml(posOrder.orderNumber)}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
          <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME}" style="width: 50px; height: 50px; padding: 3px; box-sizing: border-box; border-radius: 10px; background-color: #fff; object-fit: contain;">
          <h1 style="margin: 5px 0;">${BRAND.NAME}</h1>
          <p style="margin: 0;">POS Receipt</p>
        </div>
        <div style="padding: 20px; background: #f8f9fa;">
          <p>Dear ${escapeHtml(posOrder.customer?.name || 'Customer')},</p>
          <p>Thank you for your purchase at ${BRAND.NAME}! Here is your receipt.</p>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
            <h3 style="color: #8F0E2F; margin-top: 0;">Receipt Summary</h3>
            <p><strong>Order #:</strong> ${escapeHtml(posOrder.orderNumber)}</p>
            <p><strong>Date:</strong> ${formatDate(posOrder.createdAt)}</p>
            <p><strong>Payment:</strong> ${escapeHtml(posOrder.paymentMethod)}</p>
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
              ${rows}
            </tbody>
          </table>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 14px;">
              <div><p><strong>Subtotal:</strong></p></div>
              <div style="text-align: right;"><p>${formatCurrency(posOrder.subtotal)}</p></div>
              ${posOrder.tax > 0 ? `<div><p><strong>Tax:</strong></p></div><div style="text-align: right;"><p>${formatCurrency(posOrder.tax)}</p></div>` : ''}
              ${posOrder.discount > 0 ? `<div><p><strong>Discount:</strong></p></div><div style="text-align: right;"><p>-${formatCurrency(posOrder.discount)}</p></div>` : ''}
              ${hasAppliedBalance ? `<div><p><strong>Order total:</strong></p></div><div style="text-align: right;"><p>${formatCurrency(posOrder.total)}</p></div>` : ''}
              ${loyaltyUsed > 0 ? `<div><p><strong>Loyalty balance applied:</strong></p></div><div style="text-align: right;"><p>-${formatCurrency(loyaltyUsed)}</p></div>` : ''}
              ${giftRows}
              <div style="border-top: 2px solid #B1123B; padding-top: 10px;"><p><strong>${hasAppliedBalance ? 'Amount due:' : 'Total:'}</strong></p></div>
              <div style="border-top: 2px solid #B1123B; padding-top: 10px; text-align: right;"><p><strong>${formatCurrency(hasAppliedBalance ? posOrder.amountDue : posOrder.total)}</strong></p></div>
              ${Number(posOrder.loyaltyRewardEarned) > 0 ? `<div><p><strong>Loyalty earned:</strong></p></div><div style="text-align: right;"><p>${formatCurrency(posOrder.loyaltyRewardEarned)}</p></div>` : ''}
            </div>
          </div>
          <div style="text-align: center; margin: 20px 0;">
            <p style="color: #B1123B; font-weight: bold;">Thank you for shopping at ${BRAND.NAME}!</p>
            <p style="color: #666; font-size: 13px;">Visit us again at ${BRAND.SITE_HOST}</p>
          </div>
          ${invoiceBrandAssetsEmailBlock()}
        </div>
        <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666;">
          <p>${brandFooter()}</p>
          <p>This is an automated receipt. Please do not reply.</p>
        </div>
      </div>
    `
  };
  }
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
                <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME} Logo" style="width: 60px; height: 60px; padding: 3px; box-sizing: border-box; border-radius: 12px; background-color: #fff; object-fit: contain;">
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
    if (data?.notifySuperAdmins === true) {
      await addSuperAdminBcc(mailOptions, [to]);
    }
    if (template === 'posOrderConfirmation' && Buffer.isBuffer(data.invoicePdf) && data.invoicePdf.length > 0) {
      const orderNumber = String(data.order?.orderNumber || 'receipt').replace(/[^a-zA-Z0-9_-]/g, '');
      mailOptions.attachments = [{
        filename: `${BRAND.NAME}_POS_${orderNumber}.pdf`,
        content: data.invoicePdf,
        contentType: 'application/pdf',
      }];
    }

    const result = await sendBrandedEmail(mailOptions);
    console.log(`✅ Email sent successfully to ${to}: ${template}`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    return { success: false, error: error.message, message: error.message };
  }
};

// Send a free-form email (admin replies, custom notices) through the server email account
const sendCustomEmail = async ({ to, subject, html, text, notifySuperAdmins = false }) => {
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
    if (notifySuperAdmins) await addSuperAdminBcc(mailOptions, [to]);

    const result = await sendBrandedEmail(mailOptions);
    console.log(`✅ Custom email sent to ${to}: ${subject}`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error(`❌ Failed to send custom email to ${to}:`, error.message);
    return { success: false, error: error.message, message: error.message };
  }
};

const sendLoyaltyTierEmail = async ({ user, tierName, earnRatePercent }) => {
  const safeName = escapeEmailHtml(user?.firstName || user?.fullName || 'there');
  const safeTierName = escapeEmailHtml(tierName || 'Loyalty');
  const safeRate = escapeEmailHtml(Number(earnRatePercent).toString());
  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#222"><main style="padding:24px"><h2 style="color:#8F0E2F">Your ${BRAND.NAME} loyalty tier</h2><p>Hello ${safeName},</p><p>You have been added to the <strong>${safeTierName}</strong> loyalty tier.</p><p>You will earn <strong>${safeRate}% back in BDT loyalty balance</strong> on eligible purchases. Your available balance and activity are shown in your account.</p><p>Thank you for shopping with ${BRAND.NAME}.</p><p>${brandFooter()}</p></main></div>`;
  return sendCustomEmail({
    to: user?.email,
    subject: `${BRAND.NAME} loyalty tier: ${tierName || 'Loyalty'}`,
    html,
    text: `Hello ${user?.firstName || user?.fullName || 'there'}, you have been added to the ${tierName || 'Loyalty'} tier and will earn ${Number(earnRatePercent)}% back in BDT loyalty balance on eligible purchases.`,
  });
};

const sendDigitalProductCodesEmail = async ({ user, order, itemGroups, isManualFulfillment = false }) => {
  const name = escapeEmailHtml(user?.firstName || user?.fullName || 'there');
  const safeOrderId = escapeEmailHtml(order?.orderId || order?._id || '');
  const orderUrl = publicSiteUrl(`/profile/orders/${encodeURIComponent(order?.orderId || order?._id || '')}#digital-delivery`);
  const copyLink = (group, field) => {
    const anchor = group?.itemId ? `#digital-${encodeURIComponent(group.itemId)}-${encodeURIComponent(field)}` : '#digital-delivery';
    return `<a href="${escapeEmailHtml(`${orderUrl.split('#')[0]}${anchor}`)}" style="display:inline-block;margin-left:8px;padding:5px 9px;border:1px solid #e5b7c4;border-radius:5px;color:#8F0E2F;text-decoration:none;font-size:12px;font-weight:bold">View &amp; copy</a>`;
  };
  const htmlItems = (itemGroups || []).map((group) => `
    <section style="margin:18px 0;padding:16px;border:1px solid #eee;border-radius:8px">
      <h3 style="margin:0 0 8px;color:#8F0E2F">${escapeEmailHtml(group.productName)}</h3>
      ${group.variantName ? `<p style="margin:0 0 10px;color:#666">${escapeEmailHtml(group.variantName)}</p>` : ''}
      ${(group.codes || []).map((code, index) => `<p style="margin:8px 0"><strong>Code ${index + 1}:</strong> <code style="padding:5px 8px;background:#f7f5f3;border-radius:4px;white-space:pre-wrap;word-break:break-all">${escapeEmailHtml(code)}</code>${copyLink(group, `code-${index}`)}</p>`).join('')}
      ${(group.details || []).map(({ field, label, value }) => `<p style="margin:8px 0"><strong>${escapeEmailHtml(label)}:</strong> <span style="white-space:pre-wrap;word-break:break-word">${escapeEmailHtml(value)}</span>${copyLink(group, field || 'digital-delivery')}</p>`).join('')}
    </section>`).join('');
  const textItems = (itemGroups || []).map((group) => `${group.productName}${group.variantName ? ` (${group.variantName})` : ''}\n${(group.codes || []).map((code, index) => `Code ${index + 1}: ${code}`).join('\n')}${(group.details || []).map(({ label, value }) => `${label}: ${value}`).join('\n')}`).join('\n\n');
  const heading = isManualFulfillment ? 'Your digital delivery details' : 'Your digital items are ready';
  const intro = isManualFulfillment
    ? `Here are the digital access details for order <strong>#${safeOrderId}</strong>. Keep them private:`
    : `Payment for order <strong>#${safeOrderId}</strong> is confirmed. Keep these redemption codes private:`;
  return sendCustomEmail({
    to: user.email,
    subject: `${BRAND.NAME} digital delivery — Order #${order?.orderId || ''}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#1b1b1b"><div style="padding:24px"><h2 style="color:#8F0E2F">${heading}</h2><p>Hello ${name},</p><p>${intro}</p><p style="font-size:13px;color:#666">Your email app may not support copying directly. Use each “View &amp; copy” link to open this order and copy a field securely.</p>${htmlItems}<p style="color:#666;font-size:12px">If you need help, contact our support team and mention order #${safeOrderId}.</p></div></div>`,
    text: `Hello ${user?.firstName || user?.fullName || 'there'}, your digital delivery details for order #${order?.orderId || ''} are below. Keep them private.\n\n${textItems}\n\nView the order and use its copy controls: ${orderUrl}`,
  });
};

// Send order confirmation email
const sendCustomerOrderEmail = async (order, user, template, adminEvent) => {
  const result = await sendEmail(user?.email, template, { order, user });
  const adminResult = await sendAdminOrderNotification(order, user, adminEvent);
  if (!adminResult.success) console.warn(`Admin notification was not sent for order #${order?.orderId}: ${adminResult.message}`);
  return result;
};

const sendOrderConfirmation = async (order, user) => {
  return sendCustomerOrderEmail(order, user, 'orderConfirmation', 'new_order');
};

// Send order processing email
const sendOrderProcessing = async (order, user) => {
  return sendCustomerOrderEmail(order, user, 'orderProcessing', 'processing');
};

// Send order shipped email
const sendOrderShipped = async (order, user) => {
  return sendCustomerOrderEmail(order, user, 'orderShipped', 'shipped');
};

// Send order delivered email
const sendOrderDelivered = async (order, user) => {
  return sendCustomerOrderEmail(order, user, 'orderDelivered', 'delivered');
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
               <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME} Logo" style="width: 60px; height: 60px; padding: 3px; box-sizing: border-box; border-radius: 12px; background-color: #fff; object-fit: contain;">
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
                        ${(item.regionName || item.configuration?.regionName || item.regionId?.name) ? `Region: ${item.regionName || item.configuration?.regionName || item.regionId.name}<br>` : ''}
                        ${formatMeasureHtml(item) ? `${formatMeasureHtml(item)}<br>` : ''}
                        ${formatPreOrderLabel(item) ? `<strong>${escapeEmailHtml(formatPreOrderLabel(item))}</strong><br>` : ''}
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
                <span>${Number(order.loyaltyAmountUsed) > 0 ? 'Amount Due:' : 'Total:'}</span>
                <span>${formatCurrency(orderAmountDue(order))}</span>
              </div>
              ${loyaltySummaryHtml(order)}
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
              <a href="${publicSiteUrl(`/profile/orders/${encodeURIComponent(order.orderId)}`)}"
                 style="display: inline-block; background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); color: white; padding: 12px 25px; text-decoration: none; border-radius: 6px; font-weight: bold; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
                📋 View Order Details
              </a>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: brandFrom(),
      to: user.email,
      subject: subject,
      html: html
    };
    const result = await sendBrandedEmail(mailOptions);
    const adminResult = await sendAdminOrderNotification(order, user, 'cancelled');
    if (!adminResult.success) console.warn(`Admin cancellation notification was not sent for #${order.orderId}: ${adminResult.message}`);

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
               <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME} Logo" style="width: 60px; height: 60px; padding: 3px; box-sizing: border-box; border-radius: 12px; background-color: #fff; object-fit: contain;">
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
                        ${(item.regionName || item.configuration?.regionName || item.regionId?.name) ? `Region: ${item.regionName || item.configuration?.regionName || item.regionId.name}<br>` : ''}
                        ${formatMeasureHtml(item) ? `${formatMeasureHtml(item)}<br>` : ''}
                        ${formatPreOrderLabel(item) ? `<strong>${escapeEmailHtml(formatPreOrderLabel(item))}</strong><br>` : ''}
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
                <span>${Number(order.loyaltyAmountUsed) > 0 ? 'Amount Due:' : 'Grand Total:'}</span>
                <span>${formatCurrency(orderAmountDue(order))}</span>
              </div>
              ${loyaltySummaryHtml(order)}
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
              <a href="${publicSiteUrl(`/profile/orders/${encodeURIComponent(order.orderId)}`)}"
                 style="display: inline-block; background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); color: white; padding: 12px 25px; text-decoration: none; border-radius: 6px; font-weight: bold; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
                📋 View Order Details
              </a>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: brandFrom(),
      to: user.email,
      subject: subject,
      html: html
    };
    const result = await sendBrandedEmail(mailOptions);
    const adminResult = await sendAdminOrderNotification(order, user, 'finalized');
    if (!adminResult.success) console.warn(`Admin finalization notification was not sent for #${order.orderId}: ${adminResult.message}`);

    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('Error sending order finalization email:', error);
    return { success: false, message: error.message };
  }
};

// Sends the exact server-generated invoice PDF as a mail attachment.
const sendOrderInvoicePdf = async (order, user, pdfBuffer) => {
  try {
    if (!user?.email) return { success: false, message: 'No recipient email for this order' };
    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) return { success: false, message: 'Invoice PDF is empty' };
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const subject = `${BRAND.NAME} Invoice — Order #${order.orderId}`;
    const name = user.fullName || order.shippingAddress?.fullName || 'Customer';
    const mailOptions = {
      from: brandFrom(),
      to: user.email,
      subject,
      text: `Hello ${name}, please find your BELORELLA order invoice attached. Order #${order.orderId}.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#1b1b1b"><div style="background:#B1123B;padding:22px;text-align:center;color:#fff"><img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME}" style="display:block;width:64px;height:64px;padding:3px;box-sizing:border-box;border-radius:12px;background-color:#fff;object-fit:contain;margin:0 auto 8px"><div style="font-size:22px;font-weight:700;letter-spacing:4px">${BRAND.NAME}</div><div style="font-size:11px;margin-top:5px">${BRAND.TAGLINE}</div></div><div style="border:1px solid #eee;padding:24px"><h2 style="margin:0 0 14px;color:#8F0E2F">Your order invoice is attached</h2><p>Hello ${escapeHtml(name)},</p><p>Thank you for choosing ${BRAND.NAME}. The PDF invoice for order <strong>#${escapeHtml(order.orderId)}</strong> is attached to this email.</p><p style="color:#666;font-size:12px">If you have questions about this order, reply to this email and our team will help.</p>${invoiceBrandAssetsEmailBlock()}</div></div>`,
      attachments: [{
        filename: `${BRAND.NAME}_Order_${String(order.orderId).replace(/[^a-zA-Z0-9_-]/g, '')}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    };
    const result = await sendBrandedEmail(mailOptions);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('Error emailing order invoice PDF:', error);
    return { success: false, message: error.message };
  }
};

const sendPOSReceipt = async (posOrder, invoicePdf = null) => {
  if (!posOrder.customer?.email) {
    console.log('⚠️ No customer email for POS order', posOrder.orderNumber);
    return { success: false, message: 'No customer email' };
  }
  return await sendEmail(posOrder.customer.email, 'posOrderConfirmation', {
    order: posOrder,
    user: null,
    invoicePdf,
    notifySuperAdmins: true,
  });
};

// Send account access instructions without transmitting passwords by email.
const sendAccountCredentials = async ({ to, name, email, role = 'customer', loginUrl }) => {
  const url = publicSiteUrl(loginUrl || (role === 'admin' ? '/admin' : '/login'));
  const roleLabel = role === 'admin' ? 'Administrator' : 'Customer';
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const greetingName = escapeHtml(name || 'there');
  const recipientEmail = escapeHtml(email || to);
  const accessInstructions = role === 'admin'
    ? 'Use the sign-in details provided to you by your administrator.'
    : 'If you need to set or reset your password, choose Forgot Password on the sign-in page.';
  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #1B1B1B;">
      <div style="background: #B1123B; padding: 24px; text-align: center;">
        <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME}" style="width: 56px; height: 56px; padding: 3px; box-sizing: border-box; border-radius: 12px; background-color: #fff; object-fit: contain;">
        <h1 style="margin: 8px 0 0; font-size: 22px; letter-spacing: 4px; color: #fff;">${BRAND.NAME}</h1>
      </div>
      <div style="border: 1px solid #eee; border-top: none; padding: 28px 24px;">
        <h2 style="margin: 0 0 12px; font-size: 18px;">Your ${BRAND.NAME} account is ready</h2>
        <p style="margin: 0 0 16px; line-height: 1.6;">
          Hi ${greetingName},<br/>
          An account has been created for you as a <strong>${roleLabel}</strong>.
        </p>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <tr>
            <td style="padding: 10px 12px; background: #f7f5f3; border: 1px solid #eee; font-size: 13px; color: #666; width: 40%;">Email</td>
            <td style="padding: 10px 12px; border: 1px solid #eee; font-size: 14px; font-weight: bold;">${recipientEmail}</td>
          </tr>
        </table>
        <p style="font-size: 13px; color: #666; line-height: 1.6;">${escapeHtml(accessInstructions)}</p>
        <div style="text-align: center; margin: 20px 0;">
          <a href="${escapeHtml(url)}"
             style="display: inline-block; background: #B1123B; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 4px; font-weight: bold; letter-spacing: 1px;">
            LOG IN NOW
          </a>
        </div>
        <p style="font-size: 12px; color: #888; line-height: 1.6;">
          For your security, passwords are never included in account emails.
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
    text: `Hi ${name || 'there'}, your ${BRAND.NAME} account is ready. Email: ${email || to}. ${accessInstructions}`
  });
};

// Customer account emails are sent only for admin-created accounts or explicit
// admin password changes. Admin access emails continue to use the password-free
// sendAccountCredentials template above.
const sendUserAccountDetails = async ({ to, name, email, userName, password, phoneNumber, address, event = 'account_created' }) => {
  const safe = escapeEmailHtml;
  const greeting = safe(name || 'there');
  const profileUrl = publicSiteUrl('/profile');
  const loginUrl = publicSiteUrl('/login');
  const addressParts = [address?.street, address?.city, address?.state, address?.zipCode, address?.country].filter(Boolean);
  const addressText = addressParts.join(', ') || 'No address saved yet';
  const eventCopy = event === 'password_updated'
    ? { title: 'Your password was updated', summary: 'An administrator changed the password for your BELORELLA account.' }
    : { title: 'Your account is ready', summary: 'An administrator created a BELORELLA customer account for you.' };
  const fields = [
    ['Email', email || to],
    ['Username', userName],
    ['Password', password],
    ['Phone', phoneNumber],
    ['Address', addressText],
  ].filter(([, value]) => value);
  const fieldRows = fields.map(([label, value]) => `<tr><td style="padding:10px 12px;background:#f7f5f3;border:1px solid #eee;font-size:13px;color:#666;width:34%;vertical-align:top">${safe(label)}</td><td style="padding:10px 12px;border:1px solid #eee;font-size:14px;font-weight:600;word-break:break-word"><span style="font-family:monospace;white-space:pre-wrap">${safe(value)}</span></td></tr>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;margin:0 auto;color:#1b1b1b"><header style="background:#B1123B;padding:24px;text-align:center;color:#fff"><img src="${BRAND.LOGO_URL}" alt="${safe(BRAND.NAME)}" style="width:56px;height:56px;padding:3px;box-sizing:border-box;border-radius:12px;background:#fff;object-fit:contain"><h1 style="margin:8px 0 0;font-size:22px;letter-spacing:4px">${safe(BRAND.NAME)}</h1></header><main style="padding:24px;border:1px solid #eee"><h2 style="margin:0 0 12px;color:#8F0E2F">${eventCopy.title}</h2><p>Hello ${greeting},</p><p>${eventCopy.summary}</p><p style="font-size:13px;color:#666">Your sign-in information is shown below. Select a value in your email to copy it; many email apps do not allow copy buttons to access the clipboard.</p><table role="presentation" style="width:100%;border-collapse:collapse;margin:18px 0">${fieldRows}</table><p style="font-size:14px;line-height:1.6">After signing in, please review your profile and add your complete delivery address so your future orders can be delivered correctly.</p><p style="text-align:center;margin:22px 0"><a href="${safe(profileUrl)}" style="display:inline-block;background:#B1123B;color:#fff;padding:12px 22px;text-decoration:none;border-radius:5px;font-weight:bold">Complete your profile</a></p><p style="text-align:center;margin:0"><a href="${safe(loginUrl)}" style="color:#8F0E2F">Sign in to BELORELLA</a></p><p style="margin-top:20px;font-size:12px;color:#777">For your security, change this password after signing in and do not forward this email.</p><p>${brandFooter()}</p></main></div>`;
  const textFields = fields.map(([label, value]) => `${label}: ${value}`).join('\n');
  return sendCustomEmail({
    to,
    subject: `${BRAND.NAME} account details — ${event === 'password_updated' ? 'password updated' : 'account created'}`,
    html,
    text: `Hello ${name || 'there'},\n\n${eventCopy.summary}\n\n${textFields}\n\nPlease sign in at ${loginUrl}, then complete your delivery address in your profile: ${profileUrl}\n\nChange the password after signing in and keep these details private.`,
  });
};

module.exports = {
  sendEmail,
  sendCustomEmail,
  sendLoyaltyTierEmail,
  sendSuperAdminNotification,
  sendAdminOrderNotification,
  sendAccountCredentials,
  sendUserAccountDetails,
  sendOrderConfirmation,
  sendOrderProcessing,
  sendOrderShipped,
  sendOrderDelivered,
  sendOrderCancelled,
  sendOrderFinalization,
  sendOrderInvoicePdf,
  sendPOSReceipt,
  sendDigitalProductCodesEmail,
};
