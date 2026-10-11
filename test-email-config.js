const nodemailer = require('nodemailer');
require('dotenv').config();
const { BRAND } = require('./utils/brand');

async function testEmailConfig() {
  console.log('🧪 Testing Email Configuration...\n');

  // Check environment variables
  console.log('📋 Environment Variables:');
  console.log(`EMAIL_SERVICE: ${process.env.EMAIL_SERVICE || 'NOT SET'}`);
  console.log(`EMAIL_USER: ${process.env.EMAIL_USER || 'NOT SET'}`);
  console.log(`EMAIL_PASSWORD: ${process.env.EMAIL_PASSWORD ? 'SET' : 'NOT SET'}`);
  console.log('');

  // Validate required variables
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.log('❌ Error: EMAIL_USER and EMAIL_PASSWORD are required');
    console.log('Please check your .env file');
    return;
  }

  // Create transporter
  const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  });

  try {
    // Verify connection
    console.log('🔍 Verifying email connection...');
    await transporter.verify();
    console.log('✅ Email connection verified successfully!');

    // Send test email
    console.log('📧 Sending test email...');
    const testEmail = {
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER, // Send to yourself for testing
      subject: '🧪 BELORELLA Email Test',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
            <img src="${BRAND.LOGO_URL}" alt="${BRAND.NAME}" width="64" height="64" style="display:block;width:64px;height:64px;object-fit:contain;margin:0 auto 8px;border:0;">
            <h1 style="margin: 0;">BELORELLA</h1>
            <p style="margin: 5px 0;">Premium Fashion & Lifestyle</p>
          </div>
          
          <div style="padding: 20px; background: #f8f9fa;">
            <h2 style="color: #B1123B;">Email Configuration Test</h2>
            <p>🎉 Congratulations! Your email configuration is working correctly.</p>
            
            <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #B1123B; margin-top: 0;">Test Details</h3>
              <p><strong>Service:</strong> ${process.env.EMAIL_SERVICE || 'gmail'}</p>
              <p><strong>From:</strong> ${process.env.EMAIL_USER}</p>
              <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
            </div>
            
            <p>Your email service is now ready to send OTP verification emails and order notifications!</p>
          </div>
          
          <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} BELORELLA. All rights reserved.</p>
          </div>
        </div>
      `
    };

    const info = await transporter.sendMail(testEmail);
    console.log('✅ Test email sent successfully!');
    console.log(`📧 Message ID: ${info.messageId}`);
    console.log(`📧 Preview URL: ${nodemailer.getTestMessageUrl(info)}`);

  } catch (error) {
    console.log('❌ Email test failed:');
    console.log(error.message);
    
    if (error.code === 'EAUTH') {
      console.log('\n💡 Common Solutions:');
      console.log('1. Check your EMAIL_USER and EMAIL_PASSWORD in .env file');
      console.log('2. Make sure you\'re using an App Password (not your regular password)');
      console.log('3. Enable 2-Factor Authentication on your Gmail account');
      console.log('4. Generate a new App Password from Google Account Settings');
    }
  }
}

// Run the test
testEmailConfig();
