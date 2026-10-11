const HelpPage = require('../models/HelpPage');
const { sanitizeRichHtml } = require('../utils/sanitizeHtml');
const { BRAND } = require('../utils/brand');

const slugify = (name) =>
  String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const DEFAULT_PAGES = [
  {
    slug: 'faq',
    title: 'Frequently Asked Questions',
    icon: '❓',
    order: 1,
    seo: {
      metaTitle: 'Customer Help & FAQs | BELORELLA Bangladesh',
      metaDescription: 'Find answers about ordering, payment, delivery, digital products, returns, and rewards at BELORELLA.',
      metaKeywords: 'BELORELLA FAQ, order help, delivery Bangladesh, payment help, digital products',
      ogImage: BRAND.LOGO_URL,
    },
    content: `
      <div class="help-faq-intro">
        <p class="help-lede">A little help for a smoother shopping experience. If your question is about a specific order, keep your order number nearby when you contact us.</p>
      </div>
      <div class="faq-list">
        <details class="faq-item"><summary class="faq-question">How do I place an order?</summary><div class="faq-answer"><p>Choose your product, select its available colour, size or other options, and choose the region shown on the product page. Add it to your cart, review your delivery and payment options at checkout, then place the order. We’ll show your order details after it is submitted.</p></div></details>
        <details class="faq-item"><summary class="faq-question">Which payment methods can I use?</summary><div class="faq-answer"><p>Available methods are shown at checkout and can include Cash on Delivery, bKash, and Nagad. Digital products require the supported mobile-wallet payment and transaction details requested at checkout. Never share a wallet PIN or password with anyone.</p></div></details>
        <details class="faq-item"><summary class="faq-question">How are delivery charges and dates calculated?</summary><div class="faq-answer"><p>Delivery options, charges, and estimated arrival times depend on your address and the active checkout rules. The final details are shown before you place your order. Digital products are delivered online, have no courier delivery charge, and do not use the physical delivery options.</p></div></details>
        <details class="faq-item"><summary class="faq-question">Where can I follow my order?</summary><div class="faq-answer"><p>Sign in and open <strong>Profile → Orders</strong> to review order status and details. We also send order updates to the email address connected to your order. Contact us with your order number if you checked out as a guest or need help.</p></div></details>
        <details class="faq-item"><summary class="faq-question">When will I receive a digital code or account details?</summary><div class="faq-answer"><p>Digital access details are added by the store after the order is reviewed. Once sent, look in the order details in your account and in the email used for the order. If you cannot find the delivery email, check your spam folder and contact us with your order number.</p></div></details>
        <details class="faq-item"><summary class="faq-question">Can I change or cancel an order?</summary><div class="faq-answer"><p>Contact us as soon as possible with your order number and the change you need. We’ll check whether the order can still be updated. Changes or cancellations may not be possible after an order has been prepared, dispatched, or a digital code has been delivered.</p></div></details>
        <details class="faq-item"><summary class="faq-question">What should I do if an item arrives damaged or incorrect?</summary><div class="faq-answer"><p>Please contact us promptly with your order number, a short description, and clear photos of the item and packaging. Keep the product and packaging until our team has reviewed the request and explained the next step.</p></div></details>
        <details class="faq-item"><summary class="faq-question">How do loyalty rewards work?</summary><div class="faq-answer"><p>If your account has a loyalty balance, you can review its balance and transaction history in your profile. Eligible balances can be applied at checkout up to the amount allowed for that order. Any available reward codes can be entered where the checkout or store team instructs.</p></div></details>
      </div>`,
  },
  {
    slug: 'shipping-policy',
    title: 'Shipping Policy',
    icon: '🚚',
    order: 2,
    seo: {
      metaTitle: 'Shipping & Delivery Policy | BELORELLA Bangladesh',
      metaDescription: 'Learn how BELORELLA delivery options, estimated times, shipping charges, and digital delivery are shown at checkout.',
      metaKeywords: 'BELORELLA shipping policy, delivery Bangladesh, digital delivery',
      ogImage: BRAND.LOGO_URL,
    },
    content: `
      <p class="help-lede">We prepare each order for the delivery method selected at checkout. Your address, item type, stock, and current delivery rules determine the options available for that order.</p>
      <div class="help-callout"><strong>Before you place your order</strong><p>Check the delivery address, shipping method, charge, and estimated delivery time in the checkout summary. Those order-specific details take priority over general estimates on this page.</p></div>
      <h2>Physical products</h2>
      <ul><li>Available delivery areas, fees, and estimated times are shown after you enter your address.</li><li>Delivery estimates are estimates and can change because of weather, courier capacity, public holidays, or an incomplete address.</li><li>Please provide a reachable phone number and a complete address so the courier can coordinate delivery.</li><li>If a courier contacts you, follow the instructions provided for your shipment and keep your order number available.</li></ul>
      <h2>Digital products</h2>
      <p>Digital products do not need a courier. Checkout applies free digital delivery and disables the physical inside-Dhaka and outside-Dhaka shipping choices for a digital-only order. After the order is reviewed and the digital details are sent, check both your order page and your order email.</p>
      <div class="help-card-grid"><div class="help-card"><strong>Track your order</strong><p>Signed-in customers can follow updates from <strong>Profile → Orders</strong>.</p></div><div class="help-card"><strong>Need an address update?</strong><p>Contact us quickly with your order number. We’ll confirm whether the shipment can still be changed.</p></div></div>
      <h2>Delivery questions</h2>
      <p>If a delivery appears delayed or marked delivered but has not reached you, contact us with your order number and phone number. We’ll review the order and available courier information.</p>`,
  },
  {
    slug: 'return-policy',
    title: 'Return & Refund Policy',
    icon: '↺',
    order: 3,
    seo: {
      metaTitle: 'Returns & Refunds | BELORELLA Bangladesh',
      metaDescription: 'Read how BELORELLA reviews return, replacement, and refund requests for physical and digital purchases.',
      metaKeywords: 'BELORELLA return policy, refund Bangladesh, damaged item, digital code refund',
      ogImage: BRAND.LOGO_URL,
    },
    content: `
      <p class="help-lede">We want you to feel confident shopping with BELORELLA. If something is wrong with your order, contact our team promptly so we can review it with you.</p>
      <div class="help-callout"><strong>Start a request</strong><p>Use the Contact page or chat and include your order number, the item, what happened, and clear photos when relevant. Please wait for instructions before sending an item back.</p></div>
      <h2>Physical products</h2>
      <ul><li>Requests are reviewed against the item’s condition, order details, and applicable consumer-protection requirements.</li><li>For hygiene and safety, opened cosmetics, personal-care items, and products that cannot be resold in their original condition may not be eligible for a change-of-mind return.</li><li>If an item is damaged, defective, or different from what you ordered, tell us promptly and keep the product and packaging while we review it.</li><li>Approved returns or replacements must follow the return instructions provided by our team.</li></ul>
      <h2>Digital products</h2>
      <p>Digital codes, credentials, and access details cannot generally be returned after they have been delivered, revealed, or used. If a code appears invalid or access does not work, contact us before attempting repeated redemption. We’ll verify the delivery and help resolve confirmed issues.</p>
      <h2>Refunds</h2>
      <p>When a refund is approved, our team will confirm the amount and the available refund method with you. Processing time can depend on the payment provider and the information needed to complete the refund. Any refund is handled subject to applicable law.</p>
      <h2>Order cancellation</h2>
      <p>Contact us as soon as possible if you need to cancel. An order that is already being prepared, dispatched, or digitally fulfilled may no longer be cancellable.</p>`,
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    icon: '🔒',
    order: 4,
    seo: {
      metaTitle: 'Privacy Policy | BELORELLA Bangladesh',
      metaDescription: 'See how BELORELLA uses account, order, delivery, and support information to operate your shopping experience.',
      metaKeywords: 'BELORELLA privacy policy, customer data, online shopping Bangladesh',
      ogImage: BRAND.LOGO_URL,
    },
    content: `
      <p class="help-lede">Your information helps us provide a reliable shopping experience. This page explains, in plain language, what we use and why.</p>
      <h2>Information you provide</h2>
      <ul><li>Account details such as your name, email address, phone number, and saved address.</li><li>Order details such as products, selected options, delivery instructions, payment method, and transaction reference supplied for wallet payments.</li><li>Messages, support requests, reviews, and information you choose to add to your profile.</li></ul>
      <h2>How we use it</h2>
      <p>We use this information to process orders, arrange delivery, provide digital-product access, manage returns and rewards, respond to support requests, protect accounts, and improve the store. We may send service emails about an order or account activity. Marketing messages can be managed through the options provided in those messages.</p>
      <h2>Service providers</h2>
      <p>Information needed to complete a service may be shared with delivery partners, payment providers, and technical providers that support the website or email delivery. We limit those details to what is needed for the service.</p>
      <div class="help-callout"><strong>Protect your payment account</strong><p>BELORELLA will not need your bKash or Nagad PIN or password to confirm a payment. Do not send wallet credentials in chat, email, or an order note.</p></div>
      <h2>Storage, security, and your choices</h2>
      <p>We use safeguards designed to protect account and order information and retain it for operational, recordkeeping, and legal needs. You can review and update supported profile details in your account or contact us to ask about your information. Some records may need to be retained where required for an order or by law.</p>
      <h2>Policy updates</h2>
      <p>We may update this page as our services change. The current version will be published here with its latest update date.</p>`,
  },
  {
    slug: 'terms',
    title: 'Terms & Conditions',
    icon: '📄',
    order: 5,
    seo: {
      metaTitle: 'Terms & Conditions | BELORELLA Bangladesh',
      metaDescription: 'Review the terms for browsing, ordering, payment, digital products, and loyalty rewards at BELORELLA.',
      metaKeywords: 'BELORELLA terms and conditions, online shopping Bangladesh, digital products',
      ogImage: BRAND.LOGO_URL,
    },
    content: `
      <p class="help-lede">These terms explain the basic rules for using the BELORELLA store and placing an order. By using the site, you agree to follow them and any applicable law.</p>
      <h2>Products, prices, and availability</h2>
      <p>Product descriptions, images, prices, stock, regions, and options are provided to help you choose. Availability and final prices are confirmed at checkout. We may correct an accidental listing or stock error and will contact you if it affects an order.</p>
      <h2>Orders and payment</h2>
      <p>Submitting checkout details is a request to place an order. We may contact you to confirm information or payment. Orders can be delayed or cancelled when details cannot be verified, an item is unavailable, or payment is incomplete. The payment and delivery options available for your order are shown at checkout.</p>
      <h2>Digital products and access details</h2>
      <p>Digital codes, account credentials, and other access details are intended for the purchaser and should be kept private. Do not share passwords or account credentials publicly. Digital fulfillment is complete when the order’s access details have been delivered through the order page or associated email, subject to resolution of any verified delivery issue.</p>
      <h2>Accounts and loyalty rewards</h2>
      <p>Please keep your contact details accurate and protect your sign-in credentials. Loyalty balances, tiers, and redeem codes are governed by the eligibility and redemption information shown in your account or at checkout. Unless stated otherwise, a code is single-use and cannot be exchanged for cash.</p>
      <h2>Website use and content</h2>
      <p>Use the website lawfully and do not attempt to disrupt its operation, access another customer’s account, or misuse store content. Product names and brand marks belong to their respective owners. BELORELLA may update the website, product listings, and these terms as the store changes.</p>
      <h2>Questions and applicable requirements</h2>
      <p>Contact us through the Contact page if you have a question about an order or these terms. Nothing on this page limits rights that cannot be limited under applicable law in Bangladesh.</p>`,
  },
];

let seedDefaultsPromise;
const seedDefaults = () => {
  if (!seedDefaultsPromise) {
    seedDefaultsPromise = (async () => {
      for (const template of DEFAULT_PAGES) {
        let page = await HelpPage.findOne({ slug: template.slug });
        if (!page) {
          try {
            page = await HelpPage.create({ ...template, active: true });
          } catch (error) {
            // A parallel request may have inserted this default first.
            if (error.code !== 11000) throw error;
            page = await HelpPage.findOne({ slug: template.slug });
          }
        }
        if (!page) continue;

        let changed = false;
        // Fill missing/default content in place while preserving all existing
        // administrator-authored content and metadata.
        if (!String(page.content || '').trim()) {
          page.content = template.content;
          changed = true;
        }
        page.seo = page.seo || {};
        for (const [key, value] of Object.entries(template.seo)) {
          if (!String(page.seo[key] || '').trim()) {
            page.seo[key] = value;
            changed = true;
          }
        }
        if (changed) await page.save();
      }
    })().catch((error) => {
      seedDefaultsPromise = null;
      console.error('Failed to seed help pages:', error.message);
    });
  }
  return seedDefaultsPromise;
};

// Admin list
const getAdminHelpPages = async (req, res) => {
  try {
    await seedDefaults();
    const pages = await HelpPage.find().sort({ order: 1, title: 1 });
    res.status(200).json(pages);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch help pages', error: error.message });
  }
};

// Admin single (by id)
const getAdminHelpPage = async (req, res) => {
  try {
    const page = await HelpPage.findById(req.params.id);
    if (!page) return res.status(404).json({ message: 'Help page not found' });
    res.status(200).json(page);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch help page', error: error.message });
  }
};

// Admin create
const createHelpPage = async (req, res) => {
  try {
    const { title, content, icon, order, active, seo } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: 'Title is required' });

    const slug = slugify(title);
    const exists = await HelpPage.findOne({ slug });
    if (exists) return res.status(409).json({ message: 'A help page with this title already exists' });

    const page = await HelpPage.create({
      slug,
      title: title.trim(),
      icon: icon || '',
      content: sanitizeRichHtml(content || ''),
      order: Number(order) || 0,
      active: active !== false,
      seo: seo || {},
    });
    res.status(201).json(page);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create help page', error: error.message });
  }
};

// Admin update
const updateHelpPage = async (req, res) => {
  try {
    const page = await HelpPage.findById(req.params.id);
    if (!page) return res.status(404).json({ message: 'Help page not found' });

    const { title, content, icon, order, active, seo, slug } = req.body;
    if (title?.trim()) {
      const newSlug = slugify(title);
      if (newSlug !== page.slug) {
        const exists = await HelpPage.findOne({ slug: newSlug, _id: { $ne: page._id } });
        if (exists) return res.status(409).json({ message: 'A help page with this title already exists' });
        page.slug = newSlug;
      }
      page.title = title.trim();
    }
    if (content !== undefined) page.content = sanitizeRichHtml(content);
    if (icon !== undefined) page.icon = icon;
    if (order !== undefined) page.order = Number(order) || 0;
    if (active !== undefined) page.active = active !== false;
    if (seo !== undefined) page.seo = seo;
    if (slug) page.slug = slugify(slug);

    await page.save();
    res.status(200).json(page);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update help page', error: error.message });
  }
};

// Admin delete
const deleteHelpPage = async (req, res) => {
  try {
    const deleted = await HelpPage.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Help page not found' });
    res.status(200).json({ message: 'Help page deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete help page', error: error.message });
  }
};

// Public list (active only)
const getPublicHelpPages = async (req, res) => {
  try {
    await seedDefaults();
    const pages = await HelpPage.find({ active: true }).sort({ order: 1, title: 1 });
    res.status(200).json(pages);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch help pages', error: error.message });
  }
};

// Public single (by slug)
const getPublicHelpPage = async (req, res) => {
  try {
    await seedDefaults();
    const page = await HelpPage.findOne({ slug: req.params.slug, active: true });
    if (!page) return res.status(404).json({ message: 'Page not found' });
    res.status(200).json(page);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch help page', error: error.message });
  }
};

module.exports = {
  getAdminHelpPages,
  getAdminHelpPage,
  createHelpPage,
  updateHelpPage,
  deleteHelpPage,
  getPublicHelpPages,
  getPublicHelpPage,
};
