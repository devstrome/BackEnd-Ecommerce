const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { createAndSendOTP, verifyOTP, incrementFailedAttempts, resendOTP } = require('../utils/otpService');
const { sendAccountCredentials } = require('../utils/emailService');
const Cart = require('../models/Cart'); // Added Cart model import

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

const generateTokens = (userId) => {
  const accessToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
  const refreshToken = jwt.sign({ userId }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
};

exports.verifyAccessToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ message: 'Unauthorized' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(403).json({ message: 'Invalid or expired token' });
  }
};

exports.logout = async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const user = await User.findById(req.user._id);

  user.accessTokens = user.accessTokens.filter(t => t.token !== token);
  await user.save();

  res.json({ message: 'Logged out successfully' });
};

exports.refreshToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(403).json({ message: 'Refresh token is required' });

    const decoded = jwt.verify(token, JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.userId);

    if (user?.banned) {
      return res.status(403).json({ message: 'This account has been banned', banned: true });
    }
    if (!user || user.refreshToken !== token) {
      return res.status(403).json({ message: 'Invalid refresh token' });
    }

    const accessToken = jwt.sign({ userId: decoded.userId }, JWT_SECRET, { expiresIn: '1h' });

    user.accessTokens = (user.accessTokens || []).filter(t => t.expiresAt > Date.now());
    user.accessTokens.push({
      token: accessToken,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await user.save();

    res.json({ accessToken });
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(403).json({ message: 'Invalid or expired refresh token' });
  }
};

// Send OTP for registration
exports.sendRegistrationOTP = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({ message: 'Valid email is required' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser?.banned) {
      return res.status(403).json({ message: 'This account has been banned', banned: true });
    }
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    const result = await createAndSendOTP(email.toLowerCase(), 'registration');
    
    if (result.success) {
      res.json({ message: 'OTP sent successfully. Please check your email.' });
    } else {
      res.status(500).json({ message: result.message });
    }
  } catch (error) {
    console.error('Error sending registration OTP:', error);
    res.status(500).json({ message: 'Error sending OTP' });
  }
};

// Verify OTP and register user
exports.verifyOTPAndRegister = async (req, res) => {
  try {
    const { firstName, lastName, email, userName, password, phoneNumber, otp } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !password || !phoneNumber || !otp) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Check if phoneNumber is provided and not empty
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return res.status(400).json({ 
        message: 'Valid phone number is required',
        field: 'phoneNumber'
      });
    }

    // Phone number validation - more flexible
    const phoneRegex = /^(\+880|880|0)?1[3-9]\d{8}$/;
    
    // Trim the phone number to remove any whitespace
    const trimmedPhoneNumber = phoneNumber.trim();
    
    if (!phoneRegex.test(trimmedPhoneNumber)) {
      return res.status(400).json({ 
        message: 'Invalid Bangladeshi phone number format. Please use format: 01XXXXXXXXX or +8801XXXXXXXXX',
        field: 'phoneNumber',
        debug: {
          input: phoneNumber,
          trimmed: trimmedPhoneNumber,
          length: trimmedPhoneNumber.length,
          pattern: 'Expected: /^(\\+880|880|0)?1[3-9]\\d{8}$/'
        }
      });
    }
    
    // Normalize phone number to +880 format
    let normalizedPhone = trimmedPhoneNumber;
    if (normalizedPhone.startsWith('0')) {
      normalizedPhone = '+880' + normalizedPhone.substring(1);
    } else if (normalizedPhone.startsWith('880')) {
      normalizedPhone = '+' + normalizedPhone;
    } else if (!normalizedPhone.startsWith('+880')) {
      normalizedPhone = '+880' + normalizedPhone;
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser?.banned) {
      return res.status(403).json({ message: 'This account has been banned', banned: true });
    }
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Verify OTP first (don't mark as used yet)
    const otpResult = await verifyOTP(email.toLowerCase(), otp, 'registration', false);
    
    if (!otpResult.success) {
      // Increment failed attempts
      await incrementFailedAttempts(email.toLowerCase(), otp, 'registration');
      return res.status(400).json({ message: otpResult.message });
    }

    try {
      // Create user
      const hashedPassword = await bcrypt.hash(password, 10);
      const fullName = `${firstName} ${lastName}`.trim();
      const profileImageUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}`;

      const user = await User.create({
        firstName,
        lastName,
        fullName,
        email: email.toLowerCase(),
        userName: userName || `${firstName}.${lastName}`.toLowerCase().replace(/\s+/g, ''),
        password: hashedPassword,
        phoneNumber: normalizedPhone,
        imageUrl: profileImageUrl,
        isEmailVerified: true, // Mark as verified since OTP was verified
      });

      const { accessToken, refreshToken } = generateTokens(user._id);
      user.refreshToken = refreshToken;

      user.accessTokens = [{
        token: accessToken,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }];

      if (req.clientIdent) {
        user.lastLoginIp = req.clientIdent.ip;
        user.lastDeviceId = req.clientIdent.deviceId;
        user.lastFingerprint = req.clientIdent.fingerprint;
        user.lastNetwork = req.clientIdent.network;
      }

      await user.save();

      // Now mark the OTP as used since registration was successful
      await verifyOTP(email.toLowerCase(), otp, 'registration', true);

      res.status(201).json({ 
        message: 'User registered successfully', 
        accessToken, 
        refreshToken, 
        user: {
          _id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: user.fullName,
          email: user.email,
          userName: user.userName,
          phoneNumber: user.phoneNumber,
          imageUrl: user.imageUrl,
          isEmailVerified: user.isEmailVerified
        }
      });
    } catch (userCreationError) {
      console.error('Error creating user after OTP verification:', userCreationError);
      res.status(500).json({ message: 'Error creating user account' });
    }
  } catch (error) {
    console.error('Error registering user with OTP:', error);
    res.status(500).json({ message: 'Error registering user' });
  }
};

// Resend OTP
exports.resendOTP = async (req, res) => {
  try {
    const { email, type = 'registration' } = req.body;

    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({ message: 'Valid email is required' });
    }

    const result = await resendOTP(email.toLowerCase(), type);
    
    if (result.success) {
      res.json({ message: 'OTP resent successfully. Please check your email.' });
    } else {
      res.status(400).json({ message: result.message });
    }
  } catch (error) {
    console.error('Error resending OTP:', error);
    res.status(500).json({ message: 'Error resending OTP' });
  }
};

// Send email verification OTP
exports.sendEmailVerificationOTP = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({ message: 'Valid email is required' });
    }

    // Check if user exists
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if email is already verified
    if (user.isEmailVerified) {
      return res.status(400).json({ message: 'Email is already verified' });
    }

    const result = await createAndSendOTP(email.toLowerCase(), 'email_verification');
    
    if (result.success) {
      res.json({ message: 'Email verification OTP sent successfully. Please check your email.' });
    } else {
      res.status(500).json({ message: result.message });
    }
  } catch (error) {
    console.error('Error sending email verification OTP:', error);
    res.status(500).json({ message: 'Error sending OTP' });
  }
};

// Verify email with OTP
exports.verifyEmailWithOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    // Check if user exists
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if email is already verified
    if (user.isEmailVerified) {
      return res.status(400).json({ message: 'Email is already verified' });
    }

    const otpResult = await verifyOTP(email.toLowerCase(), otp, 'email_verification');
    
    if (!otpResult.success) {
      await incrementFailedAttempts(email.toLowerCase(), otp, 'email_verification');
      return res.status(400).json({ message: otpResult.message });
    }

    // Mark email as verified
    user.isEmailVerified = true;
    await user.save();

    res.json({ 
      message: 'Email verified successfully',
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        isEmailVerified: user.isEmailVerified
      }
    });
  } catch (error) {
    console.error('Error verifying email:', error);
    res.status(500).json({ message: 'Error verifying email' });
  }
};

// Verify OTP without password reset (for password reset flow)
exports.verifyOTP = async (req, res) => {
  try {
    const { email, otp, type = 'password_reset' } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    // Check if user exists
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ message: 'User with this email not found' });
    }

    // Verify OTP but don't mark as used yet (for password reset flow)
    const otpResult = await verifyOTP(email.toLowerCase(), otp, type, false);
    
    if (!otpResult.success) {
      // Increment failed attempts
      await incrementFailedAttempts(email.toLowerCase(), otp, type);
      return res.status(400).json({ message: otpResult.message });
    }

    res.json({ message: 'OTP verified successfully' });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ message: 'Error verifying OTP' });
  }
};

// Send forgot password OTP
exports.sendForgotPasswordOTP = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({ message: 'Valid email is required' });
    }

    // Check if user exists
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ message: 'User with this email not found' });
    }

    const result = await createAndSendOTP(email.toLowerCase(), 'password_reset');
    
    if (result.success) {
      res.json({ message: 'Password reset OTP sent successfully. Please check your email.' });
    } else {
      res.status(500).json({ message: result.message });
    }
  } catch (error) {
    console.error('Error sending forgot password OTP:', error);
    res.status(500).json({ message: 'Error sending OTP' });
  }
};

// Verify forgot password OTP and reset password
exports.verifyForgotPasswordOTP = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: 'Email, OTP, and new password are required' });
    }

    // Password validation
    if (newPassword.length < 6) {
      return res.status(400).json({ 
        message: 'Password must be at least 6 characters long',
        field: 'newPassword',
        minLength: 6,
        currentLength: newPassword.length
      });
    }

    // Optional: Add more password strength requirements
    if (newPassword.length > 128) {
      return res.status(400).json({ 
        message: 'Password must be less than 128 characters',
        field: 'newPassword',
        maxLength: 128,
        currentLength: newPassword.length
      });
    }

    // Check if user exists
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ message: 'User with this email not found' });
    }

    // Verify OTP
    const otpResult = await verifyOTP(email.toLowerCase(), otp, 'password_reset');
    
    if (!otpResult.success) {
      // Increment failed attempts
      await incrementFailedAttempts(email.toLowerCase(), otp, 'password_reset');
      return res.status(400).json({ message: otpResult.message });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update user password
    user.password = hashedPassword;
    
    // Clear all access tokens for security
    user.accessTokens = [];
    user.refreshToken = null;
    
    await user.save();

    res.json({ message: 'Password reset successfully. Please login with your new password.' });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ message: 'Error resetting password' });
  }
};

// Legacy register function (for backward compatibility)
exports.register = async (req, res) => {
  try {
    const { firstName, lastName, email, userName, password, phoneNumber } = req.body;

    // Check if phoneNumber is provided
    if (!phoneNumber) {
      return res.status(400).json({ 
        message: 'Phone number is required',
        field: 'phoneNumber'
      });
    }

    // Phone number validation - more flexible
    const phoneRegex = /^(\+880|880|0)?1[3-9]\d{8}$/;
    
    // Trim the phone number to remove any whitespace
    const trimmedPhoneNumber = phoneNumber.trim();
    
    if (!phoneRegex.test(trimmedPhoneNumber)) {
      return res.status(400).json({ 
        message: 'Invalid Bangladeshi phone number format. Please use format: 01XXXXXXXXX or +8801XXXXXXXXX',
        field: 'phoneNumber',
        debug: {
          input: phoneNumber,
          trimmed: trimmedPhoneNumber,
          length: trimmedPhoneNumber.length,
          pattern: 'Expected: /^(\\+880|880|0)?1[3-9]\\d{8}$/'
        }
      });
    }
    
    // Normalize phone number to +880 format
    let normalizedPhone = trimmedPhoneNumber;
    if (normalizedPhone.startsWith('0')) {
      normalizedPhone = '+880' + normalizedPhone.substring(1);
    } else if (normalizedPhone.startsWith('880')) {
      normalizedPhone = '+' + normalizedPhone;
    } else if (!normalizedPhone.startsWith('+880')) {
      normalizedPhone = '+880' + normalizedPhone;
    }

    const existingUser = await User.findOne({ email });
    if (existingUser?.banned) {
      return res.status(403).json({ message: 'This account has been banned', banned: true });
    }
    if (existingUser) return res.status(400).json({ message: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const fullName = `${firstName} ${lastName}`.trim();
    const profileImageUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}`;

    const user = await User.create({
      firstName,
      lastName,
      fullName,
      email,
      userName,
      password: hashedPassword,
      phoneNumber: normalizedPhone,
      imageUrl: profileImageUrl,
    });

    const { accessToken, refreshToken } = generateTokens(user._id);
    user.refreshToken = refreshToken;

    user.accessTokens = [{
      token: accessToken,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }];

    await user.save();

    res.status(201).json({ message: 'User registered successfully', accessToken, refreshToken, user });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).json({ message: 'Error registering user', error });
  }
};


exports.login = async (req, res) => {
  try {
    const { emailOrPhone, password } = req.body;

    if (!emailOrPhone || !password) {
      return res.status(400).json({ message: 'Email/Phone and password are required' });
    }

    const user = await User.findOne({
      $or: [
        { email: emailOrPhone.toLowerCase() },
        { phoneNumber: emailOrPhone.trim() },
      ],
    });

    if (!user) return res.status(400).json({ message: 'User not found' });
    if (user.banned) {
      return res.status(403).json({ message: 'This account has been banned', banned: true });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const { accessToken, refreshToken } = generateTokens(user._id);

    user.refreshToken = refreshToken;
    user.accessTokens = (user.accessTokens || []).filter(t => t.expiresAt > Date.now());
    user.accessTokens.push({
      token: accessToken,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    if (req.clientIdent) {
      user.lastLoginIp = req.clientIdent.ip;
      user.lastDeviceId = req.clientIdent.deviceId;
      user.lastFingerprint = req.clientIdent.fingerprint;
      user.lastNetwork = req.clientIdent.network;
    }

    await user.save();

    res.json({ message: 'Login successful', accessToken, refreshToken, user });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ message: 'Error logging in', error });
  }
};

// Google Sign-In / Sign-Up: verify the Google ID token, find-or-create the user, start a session
exports.loginWithGoogle = async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ message: 'Google credential is required' });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({ message: 'Google sign-in is not configured (GOOGLE_CLIENT_ID missing)' });
    }

    const oauthClient = new OAuth2Client(clientId);
    let payload;
    try {
      const ticket = await oauthClient.verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket.getPayload();
    } catch (err) {
      console.error('Google token verification failed:', err.message);
      return res.status(401).json({ message: 'Invalid or expired Google credential' });
    }

    if (!payload?.email || payload.email_verified === false) {
      return res.status(400).json({ message: 'Google account email is not verified' });
    }

    const email = payload.email.toLowerCase();
    const googleId = payload.sub;
    const firstName = (payload.given_name || payload.name?.split(' ')[0] || 'Google').trim();
    const lastName = (payload.family_name || payload.name?.split(' ').slice(1).join(' ') || 'User').trim();
    const fullName = `${firstName} ${lastName}`.trim();
    const profileImage = payload.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}`;

    // Find by googleId first, then by email (link existing local account to Google)
    let user = await User.findOne({ googleId }) || await User.findOne({ email });

    if (user?.banned) {
      return res.status(403).json({ message: 'This account has been banned', banned: true });
    }

    if (user) {
      // CRUD update: refresh profile details from Google on every sign-in
      const firstGoogleLink = !user.googleId;
      user.googleId = googleId;
      if (firstGoogleLink) user.provider = 'google';
      if (profileImage && user.imageUrl !== profileImage && user.imageUrl?.includes('ui-avatars.com')) {
        user.imageUrl = profileImage;
      }
      if (!user.isEmailVerified) user.isEmailVerified = true;
      await user.save();
    } else {
      // CRUD create: unique username from email local-part
      const baseUserName = (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9._]/g, '').toLowerCase() || 'user';
      let userName = baseUserName;
      let suffix = 1;
      while (await User.findOne({ userName })) {
        userName = `${baseUserName}${suffix++}`;
      }

      // Random password so schema/validation stays intact; user signs in via Google
      const randomPassword = crypto.randomBytes(24).toString('hex');

      user = await User.create({
        firstName,
        lastName,
        fullName,
        email,
        userName,
        password: await bcrypt.hash(randomPassword, 10),
        imageUrl: profileImage,
        googleId,
        provider: 'google',
        isEmailVerified: true,
        // Google sign-up: no real password yet -> ask the user to set one
        mustSetPassword: true,
      });
    }

    const { accessToken, refreshToken } = generateTokens(user._id);
    user.refreshToken = refreshToken;
    user.accessTokens = (user.accessTokens || []).filter(t => t.expiresAt > Date.now());
    user.accessTokens.push({
      token: accessToken,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    if (req.clientIdent) {
      user.lastLoginIp = req.clientIdent.ip;
      user.lastDeviceId = req.clientIdent.deviceId;
      user.lastFingerprint = req.clientIdent.fingerprint;
      user.lastNetwork = req.clientIdent.network;
    }
    await user.save();

    const safeUser = await User.findById(user._id).select('-password -refreshToken -accessTokens');
    res.json({ message: 'Login successful', accessToken, refreshToken, user: safeUser });
  } catch (error) {
    console.error('Error logging in with Google:', error);
    res.status(500).json({ message: 'Error logging in with Google', error: error.message });
  }
};

// Set the first password for accounts created via Google sign-up
// (mustSetPassword flag is cleared afterwards; email stays verified)
exports.setInitialPassword = async (req, res) => {
  try {
    const { password, phoneNumber, address } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }
    if (typeof phoneNumber !== 'string' || !phoneNumber.trim()) {
      return res.status(400).json({ message: 'Phone number is required' });
    }
    if (address !== undefined && (!address || typeof address !== 'object' || Array.isArray(address))) {
      return res.status(400).json({ message: 'Address must be an object' });
    }
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.mustSetPassword !== true) {
      return res.status(400).json({ message: 'This account does not need an initial password' });
    }

    user.password = await bcrypt.hash(password, 10);
    user.mustSetPassword = false;
    if (user.provider !== 'google') user.provider = 'local';

    // Also capture the contact info the Google account didn't provide
    if (phoneNumber !== undefined) {
      const raw = phoneNumber.trim();
      let normalized = raw.replace(/[\s()-]/g, '');
      if (normalized.startsWith('0')) normalized = '+880' + normalized.substring(1);
      else if (normalized.startsWith('880')) normalized = '+' + normalized;
      else if (!normalized.startsWith('+880')) normalized = '+880' + normalized;
      if (!/^\+8801[3-9]\d{8}$/.test(normalized)) {
        return res.status(400).json({ message: 'Please enter a valid Bangladeshi phone number' });
      }
      user.phoneNumber = normalized;
    }
    if (address && typeof address === 'object') {
      const allowedFields = ['street', 'city', 'state', 'zipCode', 'country'];
      for (const field of allowedFields) {
        if (address[field] !== undefined) {
          if (typeof address[field] !== 'string') {
            return res.status(400).json({ message: `Address ${field} must be a string` });
          }
          user.set(`address.${field}`, address[field].trim());
        }
      }
    }
    await user.save();

    const safeUser = await User.findById(user._id).select('-password -refreshToken -accessTokens');
    res.json({ message: 'Password set successfully', user: safeUser });
  } catch (error) {
    res.status(500).json({ message: 'Error setting password', error: error.message });
  }
};

exports.getProfile = async (req, res) => {
  try {
    res.json(req.user);
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ message: 'Error fetching profile', error });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user._id;
    const updatedData = { ...req.body };

    delete updatedData.password;
    delete updatedData.refreshToken;

    if (updatedData.phoneNumber) {
      // Check if phoneNumber is a valid string
      if (typeof updatedData.phoneNumber !== 'string') {
        return res.status(400).json({ 
          message: 'Phone number must be a valid string',
          field: 'phoneNumber'
        });
      }

      // Trim the phone number to remove any whitespace
      updatedData.phoneNumber = updatedData.phoneNumber.trim();
      
      // Check if phone number is empty after trimming
      if (!updatedData.phoneNumber) {
        return res.status(400).json({ 
          message: 'Phone number cannot be empty',
          field: 'phoneNumber'
        });
      }
      
      // Phone number validation - more flexible
      const phoneRegex = /^(\+880|880|0)?1[3-9]\d{8}$/;
      
      // Debug logging
      console.log('🔍 Phone number validation debug:');
      console.log('  - Input phone number:', updatedData.phoneNumber);
      console.log('  - Phone number type:', typeof updatedData.phoneNumber);
      console.log('  - Phone number length:', updatedData.phoneNumber.length);
      console.log('  - Regex test result:', phoneRegex.test(updatedData.phoneNumber));
      
      if (!phoneRegex.test(updatedData.phoneNumber)) {
        return res.status(400).json({ 
          message: 'Invalid Bangladeshi phone number format. Please use format: 01XXXXXXXXX or +8801XXXXXXXXX',
          field: 'phoneNumber',
          debug: {
            input: updatedData.phoneNumber,
            length: updatedData.phoneNumber.length,
            pattern: 'Expected: /^(\\+880|880|0)?1[3-9]\\d{8}$/'
          }
        });
      }
      
      // Normalize phone number to +880 format
      let normalizedPhone = updatedData.phoneNumber;
      if (normalizedPhone.startsWith('0')) {
        normalizedPhone = '+880' + normalizedPhone.substring(1);
      } else if (normalizedPhone.startsWith('880')) {
        normalizedPhone = '+' + normalizedPhone;
      } else if (!normalizedPhone.startsWith('+880')) {
        normalizedPhone = '+880' + normalizedPhone;
      }
      updatedData.phoneNumber = normalizedPhone;
    }

    if (updatedData.email) {
      updatedData.email = updatedData.email.toLowerCase().trim();
    }

    if (updatedData.firstName || updatedData.lastName) {
      const nextFirst = updatedData.firstName || req.user.firstName;
      const nextLast = updatedData.lastName || req.user.lastName;
      const fullName = `${nextFirst} ${nextLast}`.trim();
      updatedData.fullName = fullName;
      // Only regenerate the avatar placeholder if the user has never uploaded a
      // real profile picture — don't wipe an uploaded one on a name change.
      const existing = req.user.imageUrl || '';
      if (!existing || existing.includes('ui-avatars.com')) {
        updatedData.imageUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}`;
      }
    }

    const user = await User.findByIdAndUpdate(userId, updatedData, {
      new: true,
      runValidators: true,
    }).select('-password -refreshToken');

    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({ message: 'Profile updated successfully', user });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ message: 'Error updating profile', error });
  }
};

// User uploads their own profile picture
exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No image file provided' });
    const userId = req.user._id || req.user.id;
    const user = await User.findByIdAndUpdate(
      userId,
      { imageUrl: req.file.path },
      { new: true }
    ).select('-password -refreshToken -accessTokens');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'Profile image updated', user });
  } catch (error) {
    res.status(500).json({ message: 'Failed to upload image', error: error.message });
  }
};



// 🧭 Update address
exports.updateAddress = async (req, res) => {
  try {
    const userId = req.user._id;
    const { address } = req.body;

    const user = await User.findByIdAndUpdate(userId, { address }, { new: true }).select('-password -refreshToken');
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({ message: 'Address updated', user });
  } catch (error) {
    console.error('Error updating address:', error);
    res.status(500).json({ message: 'Error updating address', error });
  }
};

// 💳 Replace all payment methods
exports.updatePaymentMethods = async (req, res) => {
  try {
    const userId = req.user._id;
    const { paymentMethods } = req.body;

    const user = await User.findByIdAndUpdate(userId, { paymentMethods }, { new: true }).select('-password -refreshToken');
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({ message: 'Payment methods updated', user });
  } catch (error) {
    console.error('Error updating payment methods:', error);
    res.status(500).json({ message: 'Error updating payment methods', error });
  }
};

// ➕ Add payment method
exports.addPaymentMethod = async (req, res) => {
  try {
    const userId = req.user._id;
    const newMethod = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (newMethod.isDefault) {
      user.paymentMethods.forEach(pm => pm.isDefault = false);
    }

    user.paymentMethods.push(newMethod);
    await user.save();

    res.json({ message: 'Payment method added', user });
  } catch (error) {
    console.error('Error adding payment method:', error);
    res.status(500).json({ message: 'Error adding payment method', error });
  }
};

// 🗑️ Remove payment method by ID
exports.removePaymentMethod = async (req, res) => {
  try {
    const userId = req.user._id;
    const { methodId } = req.params;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.paymentMethods = user.paymentMethods.filter(pm => pm._id.toString() !== methodId);
    await user.save();

    res.json({ message: 'Payment method removed', user });
  } catch (error) {
    console.error('Error removing payment method:', error);
    res.status(500).json({ message: 'Error removing payment method', error });
  }
};

// ⭐ Set default payment method
exports.setDefaultPaymentMethod = async (req, res) => {
  try {
    const userId = req.user._id;
    const { methodId } = req.params;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.paymentMethods = user.paymentMethods.map(pm => ({
      ...pm.toObject(),
      isDefault: pm._id.toString() === methodId,
    }));

    await user.save();
    res.json({ message: 'Default payment method set', user });
  } catch (error) {
    console.error('Error setting default payment method:', error);
    res.status(500).json({ message: 'Error setting default payment method', error });
  }
};

exports.editPaymentMethod = async (req, res) => {
  try {
    const userId = req.user._id;
    const { methodId } = req.params;
    const updates = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const methodIndex = user.paymentMethods.findIndex(pm => pm._id.toString() === methodId);
    if (methodIndex === -1) return res.status(404).json({ message: 'Payment method not found' });

    Object.assign(user.paymentMethods[methodIndex], updates);

    await user.save();
    res.json({ message: 'Payment method updated', user });
  } catch (error) {
    console.error('Error editing payment method:', error);
    res.status(500).json({ message: 'Error editing payment method', error });
  }
};

// ❌ Delete user
exports.deleteUser = async (req, res) => {
  try {
    const userId = req.user._id;

    const user = await User.findByIdAndDelete(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: 'Error deleting user', error });
  }
};

// 👨‍💼 Admin Functions for User Management

// Get all users (admin only)
exports.getAllUsers = async (req, res) => {
  try {
    console.log('🔍 getAllUsers called by admin:', req.admin._id);
    
    // Fetch all users
    const users = await User.find({})
      .select('-password -refreshToken -accessTokens')
      .lean();

    console.log(`📊 Found ${users.length} users`);

    // Fetch all carts
    const carts = await Cart.find({})
      .populate({
        path: 'items.productId',
        select: 'name price imageUrl'
      })
      .lean();

    console.log(`🛒 Found ${carts.length} carts`);

    // Create a map of userId to cart
    const cartMap = new Map();
    carts.forEach(cart => {
      cartMap.set(cart.userId.toString(), cart);
    });

    // Process users to include cart information
    const processedUsers = users.map(user => {
      const userCart = cartMap.get(user._id.toString());
      const hasCart = userCart && userCart.items && userCart.items.length > 0;
      
      return {
        ...user,
        cart: userCart || null,
        hasCart,
        cartItemsCount: hasCart ? userCart.items.length : 0,
        cartTotal: hasCart ? userCart.totalAmount : 0
      };
    });

    console.log(`✅ Processed ${processedUsers.length} users with cart data`);
    res.status(200).json(processedUsers);
  } catch (error) {
    console.error('❌ Error in getAllUsers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: error.message
    });
  }
};

// Get specific user by ID (admin only)
exports.getUserById = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId)
      .select('-password -refreshToken -accessTokens')
      .populate('paymentMethods');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error fetching user by ID:', error);
    res.status(500).json({ message: 'Error fetching user', error: error.message });
  }
};

// Create user by admin (super admin only) — user receives their credentials by email
exports.createUserByAdmin = async (req, res) => {
  try {
    if (!req.admin?.superAdmin) {
      return res.status(403).json({ message: 'Only super admin can create users' });
    }

    const { firstName, lastName, email, userName, password, phoneNumber } = req.body;

    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !userName?.trim() || !password) {
      return res.status(400).json({ message: 'firstName, lastName, email, userName and password are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    // Normalize phone to +880 format (same rules as self-registration)
    const phoneRegex = /^(\+880|880|0)?1[3-9]\d{8}$/;
    const trimmedPhone = (phoneNumber || '').trim();
    if (!phoneRegex.test(trimmedPhone)) {
      return res.status(400).json({
        message: 'Invalid Bangladeshi phone number format. Please use format: 01XXXXXXXXX or +8801XXXXXXXXX',
        field: 'phoneNumber',
      });
    }
    let normalizedPhone = trimmedPhone;
    if (normalizedPhone.startsWith('0')) normalizedPhone = '+880' + normalizedPhone.substring(1);
    else if (normalizedPhone.startsWith('880')) normalizedPhone = '+' + normalizedPhone;
    else if (!normalizedPhone.startsWith('+880')) normalizedPhone = '+880' + normalizedPhone;

    const emailTrimmed = email.trim().toLowerCase();
    const userNameTrimmed = userName.trim();
    const existing = await User.findOne({ $or: [{ email: emailTrimmed }, { userName: userNameTrimmed }] });
    if (existing) {
      return res.status(400).json({ message: `${userNameTrimmed} or ${emailTrimmed} is already taken` });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
    const imageUrl = req.file?.path || `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}`;

    const user = await User.create({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      fullName,
      email: emailTrimmed,
      userName: userNameTrimmed,
      password: hashedPassword,
      phoneNumber: normalizedPhone,
      imageUrl,
      isEmailVerified: true, // created and verified by the super admin
    });

    const safeUser = await User.findById(user._id).select('-password -refreshToken -accessTokens');

    // Email the new user their login credentials (non-blocking)
    sendAccountCredentials({
      to: emailTrimmed,
      name: fullName,
      email: emailTrimmed,
      password,
      role: 'customer',
      loginUrl: process.env.CLIENT_URL,
    }).catch((err) => console.error('Failed to send user credentials email:', err.message));

    res.status(201).json({ message: 'User created successfully', user: safeUser });
  } catch (error) {
    console.error('Error creating user by admin:', error);
    res.status(500).json({ message: 'Error creating user', error: error.message });
  }
};

// Update user by admin (admin only)
exports.updateUserByAdmin = async (req, res) => {
  try {
    const { userId } = req.params;
    const updatedData = { ...req.body };

    // Remove sensitive fields that shouldn't pass through verbatim
    delete updatedData.refreshToken;
    delete updatedData.accessTokens;

    // Admin may set a new password when provided
    if (typeof updatedData.password === 'string' && updatedData.password.trim()) {
      if (updatedData.password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters' });
      }
      updatedData.password = await bcrypt.hash(updatedData.password.trim(), 10);
    } else {
      delete updatedData.password;
    }

    if (updatedData.phoneNumber) {
      // Check if phoneNumber is a valid string
      if (typeof updatedData.phoneNumber !== 'string') {
        return res.status(400).json({ 
          message: 'Phone number must be a valid string',
          field: 'phoneNumber'
        });
      }

      // Trim the phone number to remove any whitespace
      updatedData.phoneNumber = updatedData.phoneNumber.trim();
      
      // Check if phone number is empty after trimming
      if (!updatedData.phoneNumber) {
        return res.status(400).json({ 
          message: 'Phone number cannot be empty',
          field: 'phoneNumber'
        });
      }
      
      // Phone number validation - more flexible
      const phoneRegex = /^(\+880|880|0)?1[3-9]\d{8}$/;
      
      if (!phoneRegex.test(updatedData.phoneNumber)) {
        return res.status(400).json({ 
          message: 'Invalid Bangladeshi phone number format. Please use format: 01XXXXXXXXX or +8801XXXXXXXXX',
          field: 'phoneNumber'
        });
      }
      
      // Normalize phone number to +880 format
      let normalizedPhone = updatedData.phoneNumber;
      if (normalizedPhone.startsWith('0')) {
        normalizedPhone = '+880' + normalizedPhone.substring(1);
      } else if (normalizedPhone.startsWith('880')) {
        normalizedPhone = '+' + normalizedPhone;
      } else if (!normalizedPhone.startsWith('+880')) {
        normalizedPhone = '+880' + normalizedPhone;
      }
      updatedData.phoneNumber = normalizedPhone;
    }

    if (updatedData.email) {
      updatedData.email = updatedData.email.toLowerCase().trim();
    }

    if (updatedData.firstName || updatedData.lastName) {
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const nextFirst = updatedData.firstName || user.firstName;
      const nextLast = updatedData.lastName || user.lastName;
      const fullName = `${nextFirst} ${nextLast}`.trim();
      updatedData.fullName = fullName;
      const existing = user.imageUrl || '';
      if (!existing || existing.includes('ui-avatars.com')) {
        updatedData.imageUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}`;
      }
    }

    // Admin can replace the user's profile picture
    if (req.file?.path) updatedData.imageUrl = req.file.path;

    const user = await User.findByIdAndUpdate(userId, updatedData, {
      new: true,
      runValidators: true,
    }).select('-password -refreshToken -accessTokens');

    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({ message: 'User updated successfully', user });
  } catch (error) {
    console.error('Error updating user by admin:', error);
    res.status(500).json({ message: 'Error updating user', error: error.message });
  }
};

// Delete user by admin (admin only)
exports.deleteUserByAdmin = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findByIdAndDelete(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user by admin:', error);
    res.status(500).json({ message: 'Error deleting user', error: error.message });
  }
};

// 🔐 Update password with current password verification
exports.updatePassword = async (req, res) => {
  try {
    const userId = req.user._id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required' });
    }

    // Password validation
    if (newPassword.length < 8) {
      return res.status(400).json({ 
        message: 'Password must be at least 8 characters long',
        field: 'newPassword'
      });
    }

    // Check for password strength
    const hasLowercase = /[a-z]/.test(newPassword);
    const hasUppercase = /[A-Z]/.test(newPassword);
    const hasNumber = /\d/.test(newPassword);

    if (!hasLowercase || !hasUppercase || !hasNumber) {
      return res.status(400).json({ 
        message: 'Password must contain at least one lowercase letter, one uppercase letter, and one number',
        field: 'newPassword'
      });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Check if new password is same as current
    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) {
      return res.status(400).json({ message: 'New password must be different from current password' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    user.password = hashedPassword;
    
    // Clear all access tokens for security (force re-login)
    user.accessTokens = [];
    user.refreshToken = null;
    
    await user.save();

    res.json({ message: 'Password updated successfully. Please login again with your new password.' });
  } catch (error) {
    console.error('Error updating password:', error);
    res.status(500).json({ message: 'Error updating password', error: error.message });
  }
};

// 📧 Send email update OTP
exports.sendEmailUpdateOTP = async (req, res) => {
  try {
    const userId = req.user._id;
    const { newEmail } = req.body;

    if (!newEmail || !/\S+@\S+\.\S+/.test(newEmail)) {
      return res.status(400).json({ message: 'Valid email is required' });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if new email is same as current
    if (user.email.toLowerCase() === newEmail.toLowerCase()) {
      return res.status(400).json({ message: 'New email must be different from current email' });
    }

    // Check if new email is already taken
    const existingUser = await User.findOne({ email: newEmail.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ message: 'Email is already in use by another account' });
    }

    // Send OTP to new email
    const result = await createAndSendOTP(newEmail.toLowerCase(), 'email_change');
    
    if (result.success) {
      res.json({ message: 'Email update OTP sent successfully. Please check your new email.' });
    } else {
      res.status(500).json({ message: result.message });
    }
  } catch (error) {
    console.error('Error sending email update OTP:', error);
    res.status(500).json({ message: 'Error sending OTP', error: error.message });
  }
};

// 📧 Update email with OTP verification
exports.updateEmail = async (req, res) => {
  try {
    const userId = req.user._id;
    const { newEmail, otp } = req.body;

    if (!newEmail || !otp) {
      return res.status(400).json({ message: 'New email and OTP are required' });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if new email is same as current
    if (user.email.toLowerCase() === newEmail.toLowerCase()) {
      return res.status(400).json({ message: 'New email must be different from current email' });
    }

    // Check if new email is already taken
    const existingUser = await User.findOne({ email: newEmail.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ message: 'Email is already in use by another account' });
    }

    // Verify OTP
    const otpResult = await verifyOTP(newEmail.toLowerCase(), otp, 'email_change');
    
    if (!otpResult.success) {
      // Increment failed attempts
      await incrementFailedAttempts(newEmail.toLowerCase(), otp, 'email_change');
      return res.status(400).json({ message: otpResult.message });
    }

    // Update email
    user.email = newEmail.toLowerCase();
    user.isEmailVerified = true; // Mark as verified since OTP was verified
    
    // Clear all access tokens for security (force re-login)
    user.accessTokens = [];
    user.refreshToken = null;
    
    await user.save();

    res.json({ 
      message: 'Email updated successfully. Please login again with your new email.',
      user: {
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        isEmailVerified: user.isEmailVerified
      }
    });
  } catch (error) {
    console.error('Error updating email:', error);
    res.status(500).json({ message: 'Error updating email', error: error.message });
  }
};
