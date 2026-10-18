require('dotenv').config();
const { verifyEmailConnection, sendCustomEmail } = require('./utils/emailService');

async function verifyEmailConfig() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    throw new Error('Set EMAIL_USER and EMAIL_PASSWORD before checking Gmail SMTP.');
  }

  console.log('Checking Gmail SMTP credentials and connection...');
  await verifyEmailConnection();
  console.log('Gmail SMTP connection verified.');

  if (!process.argv.includes('--send-test-email')) {
    console.log('No email was sent. Pass --send-test-email to send a branded test to the configured sender mailbox.');
    return;
  }

  const result = await sendCustomEmail({
    to: process.env.EMAIL_USER,
    subject: 'BELORELLA Gmail SMTP delivery check',
    html: '<div style="font-family:Arial,sans-serif"><h2>Gmail SMTP is connected</h2><p>This is a delivery check for the BELORELLA email service.</p></div>',
    text: 'Gmail SMTP is connected. This is a delivery check for the BELORELLA email service.',
  });
  if (!result.success) throw new Error(result.message || 'Test message was not accepted by Gmail.');
  console.log('Gmail accepted the test message for delivery to the sender mailbox.');
}

verifyEmailConfig().catch((error) => {
  console.error('Gmail SMTP check failed:', error.message);
  process.exitCode = 1;
});
