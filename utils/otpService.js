const OTP = require('../models/OTP');
const { sendEmail } = require('./emailService');
const { randomInt } = require('crypto');

const OTP_TYPES = new Set(['registration', 'password_reset', 'email_change', 'email_verification']);
const normalizeOtpRequest = (email, type) => {
  if (typeof email !== 'string' || typeof type !== 'string' || !OTP_TYPES.has(type)) return null;
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return null;
  return { email: normalizedEmail, type };
};

// Generate 6-digit OTP
const generateOTP = () => {
  return String(randomInt(100000, 1000000));
};

// Send OTP email
const sendOTPEmail = async (email, otp, type = 'registration') => {
              const emailTemplates = {
              registration: {
                subject: 'Email Verification - BELORELLA',
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
                      <h1 style="margin: 0;">BELORELLA</h1>
                      <p style="margin: 5px 0;">Premium Fashion & Lifestyle</p>
                    </div>
                    
                    <div style="padding: 20px; background: #f8f9fa;">
                      <h2 style="color: #B1123B;">Email Verification</h2>
                      <p>Thank you for registering with BELORELLA! Please verify your email address to complete your registration.</p>
                      
                      <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
                        <h3 style="color: #B1123B; margin-top: 0;">Your Verification Code</h3>
                        <div style="font-size: 32px; font-weight: bold; color: #B1123B; letter-spacing: 8px; margin: 20px 0;">
                          ${otp}
                        </div>
                        <p style="color: #666; margin: 0;">This code will expire in 10 minutes</p>
                      </div>
                      
                      <div style="background: #FDF2F5; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
                        <h4 style="color: #B1123B; margin-top: 0;">Important:</h4>
                        <ul style="color: #B1123B; margin: 0;">
                          <li>Never share this code with anyone</li>
                          <li>BELORELLA will never ask for this code via phone or email</li>
                          <li>If you didn't request this code, please ignore this email</li>
                        </ul>
                      </div>
                      
                      <div style="text-align: center; margin: 30px 0;">
                        <p style="color: #B1123B; font-weight: bold;">Welcome to BELORELLA!</p>
                      </div>
                    </div>
                    
                    <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666;">
                      <p>© ${new Date().getFullYear()} BELORELLA. All rights reserved.</p>
                      <p>This is an automated email. Please do not reply to this message.</p>
                    </div>
                  </div>
                `
              },
              email_verification: {
                subject: 'Email Verification - BELORELLA',
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
                      <h1 style="margin: 0;">BELORELLA</h1>
                      <p style="margin: 5px 0;">Premium Fashion & Lifestyle</p>
                    </div>
                    
                    <div style="padding: 20px; background: #f8f9fa;">
                      <h2 style="color: #B1123B;">Email Verification</h2>
                      <p>Please verify your email address to complete your account setup and access all features.</p>
                      
                      <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
                        <h3 style="color: #B1123B; margin-top: 0;">Your Verification Code</h3>
                        <div style="font-size: 32px; font-weight: bold; color: #B1123B; letter-spacing: 8px; margin: 20px 0;">
                          ${otp}
                        </div>
                        <p style="color: #666; margin: 0;">This code will expire in 10 minutes</p>
                      </div>
                      
                      <div style="background: #FDF2F5; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
                        <h4 style="color: #B1123B; margin-top: 0;">Why verify your email?</h4>
                        <ul style="color: #B1123B; margin: 0;">
                          <li>Secure your account and protect your information</li>
                          <li>Receive important updates and notifications</li>
                          <li>Access all premium features and services</li>
                          <li>Reset your password if needed</li>
                        </ul>
                      </div>
                      
                      <div style="text-align: center; margin: 30px 0;">
                        <p style="color: #B1123B; font-weight: bold;">Thank you for choosing BELORELLA!</p>
                      </div>
                    </div>
                    
                    <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666;">
                      <p>© ${new Date().getFullYear()} BELORELLA. All rights reserved.</p>
                      <p>This is an automated email. Please do not reply to this message.</p>
                    </div>
                  </div>
                `
              },
    password_reset: {
      subject: 'Password Reset - BELORELLA',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
            <h1 style="margin: 0;">BELORELLA</h1>
            <p style="margin: 5px 0;">Premium Fashion & Lifestyle</p>
          </div>
          
          <div style="padding: 20px; background: #f8f9fa;">
            <h2 style="color: #B1123B;">Password Reset</h2>
            <p>We received a request to reset your password. Use the code below to verify your identity.</p>
            
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
              <h3 style="color: #B1123B; margin-top: 0;">Your Reset Code</h3>
              <div style="font-size: 32px; font-weight: bold; color: #B1123B; letter-spacing: 8px; margin: 20px 0;">
                ${otp}
              </div>
              <p style="color: #666; margin: 0;">This code will expire in 10 minutes</p>
            </div>
            
            <div style="background: #FDF2F5; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
              <h4 style="color: #B1123B; margin-top: 0;">Security Notice:</h4>
              <ul style="color: #B1123B; margin: 0;">
                <li>If you didn't request this reset, please ignore this email</li>
                <li>Your password will remain unchanged</li>
                <li>Contact support if you have concerns</li>
              </ul>
            </div>
          </div>
          
          <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} BELORELLA. All rights reserved.</p>
            <p>This is an automated email. Please do not reply to this message.</p>
          </div>
        </div>
      `
    },
    email_change: {
      subject: 'Email Update Verification - BELORELLA',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #B1123B 0%, #8F0E2F 100%); padding: 20px; text-align: center; color: white;">
            <h1 style="margin: 0;">BELORELLA</h1>
            <p style="margin: 5px 0;">Email Update Verification</p>
          </div>
          
          <div style="padding: 20px; background: #f8f9fa;">
            <h2 style="color: #B1123B;">Email Update Request</h2>
            <p>We received a request to update your email address. Use the verification code below to complete the process.</p>
            
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
              <h3 style="color: #B1123B; margin-top: 0;">Your Verification Code</h3>
              <div style="font-size: 32px; font-weight: bold; color: #B1123B; letter-spacing: 8px; margin: 20px 0;">
                ${otp}
              </div>
              <p style="color: #666; margin: 0;">This code will expire in 10 minutes</p>
            </div>
            
            <div style="background: #FDF2F5; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #B1123B;">
              <h4 style="color: #8F0E2F; margin-top: 0;">Important Information:</h4>
              <ul style="color: #8F0E2F; margin: 0;">
                <li>If you didn't request this change, please ignore this email</li>
                <li>For security, you'll be logged out after updating your email</li>
                <li>Never share this code with anyone</li>
              </ul>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <p style="color: #B1123B; font-weight: bold;">Thank you for choosing BELORELLA!</p>
            </div>
          </div>
          
          <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} BELORELLA. All rights reserved.</p>
            <p>This is an automated email. Please do not reply to this message.</p>
          </div>
        </div>
      `
    }
  };

  const template = emailTemplates[type] || emailTemplates.registration;
  
  return await sendEmail(email, 'custom', {
    order: { orderId: 'OTP' },
    user: { firstName: 'User', lastName: '', email },
    customSubject: template.subject,
    customHtml: template.html
  });
};

// Create and send OTP
const createAndSendOTP = async (email, type = 'registration') => {
  try {
    const normalized = normalizeOtpRequest(email, type);
    if (!normalized) return { success: false, message: 'A valid email and verification type are required' };
    email = normalized.email;

    // Apply the per-address cooldown here as well as in resendOTP so direct
    // registration/reset endpoints cannot bypass it by requesting a new OTP.
    const recentOTP = await OTP.findOne({
      email,
      type,
      isUsed: false,
      createdAt: { $gt: new Date(Date.now() - 60 * 1000) },
    }).select('_id').lean();
    if (recentOTP) return { success: false, message: 'Please wait 1 minute before requesting a new OTP' };

    // Delete any existing unused OTPs for this email and type
    await OTP.deleteMany({ 
      email, 
      type, 
      isUsed: false 
    });

    // Generate new OTP
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Save OTP to database
    const otpDoc = new OTP({
      email,
      otp,
      type,
      expiresAt
    });
    await otpDoc.save();

    // Send OTP email
    const emailResult = await sendOTPEmail(email, otp, type);
    
    if (emailResult.success) {
      console.log(`✅ OTP sent successfully to ${email} for ${type}`);
      return { success: true, message: 'OTP sent successfully' };
    } else {
      // Delete the OTP if email failed
      await OTP.findByIdAndDelete(otpDoc._id);
      console.log(`❌ Failed to send OTP to ${email}: ${emailResult.message}`);
      return { success: false, message: emailResult.message };
    }
  } catch (error) {
    console.error(`❌ Error creating/sending OTP to ${email}:`, error.message);
    return { success: false, message: 'Failed to send OTP' };
  }
};

// Verify OTP
const verifyOTP = async (email, otp, type = 'registration', markAsUsed = true) => {
  try {
    const normalized = normalizeOtpRequest(email, type);
    if (!normalized || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
      return { success: false, message: 'Invalid or expired OTP' };
    }
    email = normalized.email;
    console.log(`🔍 Verifying OTP for ${email}, type: ${type}, markAsUsed: ${markAsUsed}`);
    
    const otpDoc = await OTP.findOne({
      email: email.toLowerCase(),
      otp,
      type,
      isUsed: false,
      expiresAt: { $gt: new Date() }
    });

    if (!otpDoc) {
      console.log(`❌ OTP not found or expired for ${email}`);
      return { success: false, message: 'Invalid or expired OTP' };
    }

    console.log(`📋 Found OTP document: ${otpDoc._id}, attempts: ${otpDoc.attempts}`);

    // Check attempts
    if (otpDoc.attempts >= 5) {
      await OTP.findByIdAndUpdate(otpDoc._id, { isUsed: true });
      console.log(`❌ Too many failed attempts for ${email}`);
      return { success: false, message: 'Too many failed attempts. Please request a new OTP.' };
    }

    // Mark OTP as used only if markAsUsed is true
    if (markAsUsed) {
      await OTP.findByIdAndUpdate(otpDoc._id, { isUsed: true });
      console.log(`✅ OTP marked as used for ${email}`);
    }
    
    console.log(`✅ OTP verified successfully for ${email}${markAsUsed ? ' (marked as used)' : ' (not marked as used)'}`);
    return { success: true, message: 'OTP verified successfully' };
  } catch (error) {
    console.error(`❌ Error verifying OTP for ${email}:`, error.message);
    return { success: false, message: 'Failed to verify OTP' };
  }
};

// Increment failed attempts
const incrementFailedAttempts = async (email, otp, type = 'registration') => {
  try {
    const normalized = normalizeOtpRequest(email, type);
    if (!normalized) return;
    await OTP.findOneAndUpdate(
      {
        email: normalized.email,
        type: normalized.type,
        isUsed: false,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: 5 },
      },
      { $inc: { attempts: 1 } }
    );
  } catch (error) {
    console.error(`❌ Error incrementing failed attempts for ${email}:`, error.message);
  }
};

// Resend OTP
const resendOTP = async (email, type = 'registration') => {
  try {
    const normalized = normalizeOtpRequest(email, type);
    if (!normalized) return { success: false, message: 'A valid email and verification type are required' };
    email = normalized.email;
    // Check if there's a recent OTP (within 1 minute)
    const recentOTP = await OTP.findOne({
      email: email.toLowerCase(),
      type,
      isUsed: false,
      createdAt: { $gt: new Date(Date.now() - 60 * 1000) }
    });

    if (recentOTP) {
      return { success: false, message: 'Please wait 1 minute before requesting a new OTP' };
    }

    return await createAndSendOTP(email, type);
  } catch (error) {
    console.error(`❌ Error resending OTP to ${email}:`, error.message);
    return { success: false, message: 'Failed to resend OTP' };
  }
};

module.exports = {
  generateOTP,
  sendOTPEmail,
  createAndSendOTP,
  verifyOTP,
  incrementFailedAttempts,
  resendOTP
};
