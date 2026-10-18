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

## Admin recipients

Admin notification recipients come from active administrator accounts in MongoDB. Superadmins receive every operational notice. Other admins receive only notices for their assigned permission areas (for example, Inbox for chat, Orders for order events, and Contact messages for contact-form submissions). No static recipient-list environment variable is needed. Assign the matching permission to an admin account to include it in that area's notifications.

## Render and VPS networking

This project now uses Gmail SMTP only. Render Free blocks outbound SMTP, including port 587, so Gmail SMTP will not work on that plan. Use a host that allows outbound TCP 587 (such as the planned VPS/AWS deployment), then set `EMAIL_USER` and a newly generated Gmail App Password in `EMAIL_PASSWORD`. Remove old `RESEND_API_KEY` and `RESEND_FROM_EMAIL` settings; they are no longer read by the application.

After deployment, a signed-in admin can call `POST /api/cron/email-config/verify` to check Gmail SMTP authentication without sending a message. A superadmin can call `POST /api/cron/email-config/test-admin` to send a real delivery check to active admins across assigned areas. `GET /api/cron/email-config` reports whether email and notification recipients are configured.

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

1. Confirm the host allows outbound TCP 587 and that `EMAIL_USER` plus a Gmail App Password are set.
2. Call `POST /api/cron/email-config/verify` and check server logs for the SMTP connection error.
3. Confirm the intended administrators are active in MongoDB and have the matching permission assigned. Superadmins receive all areas.
4. For message/order delivery, check the backend logs for notification failure details and the Gmail Sent folder / recipient spam folder.

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
