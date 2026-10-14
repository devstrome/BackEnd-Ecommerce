# Email & Cron Management Setup

This document explains how to set up the automated email notification system for orders.

## Features

- **Order Confirmation Emails**: Sent immediately when an order is created
- **Order Processing Emails**: Sent when order status changes to "processing"
- **Order Delivered Emails**: Sent when order status changes to "delivered"
- **Cron Job Management**: Automated email processing with manual triggers
- **Beautiful Email Templates**: Professional HTML emails with Barvella branding

## Environment Variables

Add these to your `.env` file:

```env
# Email Configuration
EMAIL_SERVICE=gmail
EMAIL_USER=your_email@gmail.com
EMAIL_PASSWORD=your_app_password_here
```

## Gmail Setup (Recommended)

1. **Enable 2-Factor Authentication** on your Gmail account
2. **Generate App Password**:
   - Go to Google Account settings
   - Security → 2-Step Verification → App passwords
   - Generate a new app password for "Mail"
   - Use this password in `EMAIL_PASSWORD`

## Render setup

Render's free web services block outbound SMTP traffic on ports 25, 465, and 587, so Gmail SMTP will time out there. The backend now supports the Resend HTTPS API, which works over port 443:

1. Add and verify `belorella.com` (or a sending subdomain) in Resend and publish the DNS records Resend provides.
2. Create a Resend API key.
3. In the Render backend service's **Environment** settings, add:

   ```env
   RESEND_API_KEY=re_...
   RESEND_FROM_EMAIL=BELORELLA <orders@belorella.com>
   ```

   Use an actual sender address on the verified domain. Keep `EMAIL_USER` and `EMAIL_PASSWORD` out of the Resend API setup; when `RESEND_API_KEY` is present, the app uses Resend for every email.
4. Save the environment settings and redeploy/restart the backend.
5. Send a test order email, then inspect the Resend email logs if it is accepted but does not reach the inbox.

On a paid Render instance or your future VPS, you can continue using Gmail SMTP with `EMAIL_SERVICE`, `EMAIL_USER`, and a Gmail app password. If `RESEND_API_KEY` remains set, the app will keep using Resend until that key is removed.

## Cron Job Schedule

- **Order Confirmation**: Every 5 minutes (checks for pending orders)
- **Order Processing**: Every 10 minutes (checks for processing orders)
- **Order Delivered**: Every 15 minutes (checks for delivered orders)
- **Daily Cleanup**: Every day at 2 AM

## API Endpoints

### Admin Only (requires authentication)

- `GET /api/cron/status` - Get cron job status
- `POST /api/cron/start` - Start all cron jobs
- `POST /api/cron/stop` - Stop all cron jobs
- `GET /api/cron/email-config` - Check email configuration
- `POST /api/cron/trigger/confirmation` - Manually trigger confirmation emails
- `POST /api/cron/trigger/processing` - Manually trigger processing emails
- `POST /api/cron/trigger/delivered` - Manually trigger delivered emails

## Email Templates

### Order Confirmation

- Sent immediately when order is created
- Includes order details, shipping address, and items
- Professional Barvella branding

### Order Processing

- Sent when order status changes to "processing"
- Explains what's happening with the order
- Builds customer confidence

### Order Delivered

- Sent when order status changes to "delivered"
- Includes next steps and quality guarantee
- Encourages reviews and future purchases

## Database Changes

The Order model now includes:

```javascript
emailSent: {
  type: String,
  enum: ['confirmation', 'processing', 'delivered', null],
  default: null
}
```

## Testing

1. **Create a test order** and check for immediate confirmation email
2. **Update order status** to "processing" and check for processing email
3. **Update order status** to "delivered" and check for delivered email
4. **Use manual triggers** to test email sending without waiting for cron jobs

## Troubleshooting

### Emails not sending

1. On Render Free, confirm `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are set on the backend service and the sender domain is verified.
2. Check Render logs for the provider error and Resend's email logs for delivery events.
3. For SMTP hosting, verify the provider credentials and confirm outbound SMTP is allowed by the host.

### Cron jobs not running

1. Check server logs for cron initialization
2. Verify timezone settings (Asia/Dhaka)
3. Use manual triggers to test email functionality
4. Check cron job status via API

### Email template issues

1. Check browser console for HTML rendering
2. Verify email client compatibility
3. Test with different email providers

## Security Notes

- Email credentials are stored in environment variables
- All cron endpoints require admin authentication
- Email sending failures don't affect order processing
- App passwords are recommended over regular passwords

## Monitoring

Monitor the system through:

- Server logs (email sending status)
- Cron job status API
- Email configuration API
- Database emailSent field tracking
