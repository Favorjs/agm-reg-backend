const express = require('express');
const cors = require('cors');
const { Sequelize, DataTypes, Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
require('dotenv').config();
const twilio = require('twilio');
const app = express();
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID
const TWILIO_AUTH_TOKEN = process.env.TWILIO_ACCOUNT_TOKEN
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER
const fetch = require('node-fetch');

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Mailgun Configuration
const formData = require('form-data');
const Mailgun = require('mailgun.js');
const mailgun = new Mailgun(formData);
const mg = mailgun.client({
  username: 'api',
  key: process.env.MAILGUN_API_KEY || 'key-yourkeyhere',
  url: 'https://api.mailgun.net' // For EU domains use: 'https://api.eu.mailgun.net'
});

class MailgunService {
  constructor() {
    this.domain = process.env.MAILGUN_DOMAIN || 'registrars.apel.com.ng';
    this.fromEmail = process.env.MAILGUN_FROM_EMAIL || 'alerts@registrars.apel.com.ng';
    this.fromName = 'SAHCO AGM';
  }

  // Send email via Mailgun
  async sendEmail(to, subject, html, text = '') {
    try {
      if (!to || !subject || !html) {
        throw new Error('Missing required email parameters');
      }

      // If no plain text provided, create a simple version from HTML
      if (!text) {
        text = html.replace(/<[^>]*>/g, ''); // Strip HTML tags
      }

      const data = {
        from: `${this.fromName} <${this.fromEmail}>`,
        to: to,
        subject: subject,
        html: html,
        text: text,
        // You can add tracking options if needed
        'o:tracking': 'yes',
        'o:tracking-clicks': 'yes',
        'o:tracking-opens': 'yes'
      };

      const response = await mg.messages.create(this.domain, data);
      
      console.log(`✅ Mailgun email sent to ${to}`, {
        messageId: response.id,
        timestamp: new Date().toISOString()
      });
      
      return { 
        success: true, 
        messageId: response.id,
        response: response 
      };
    } catch (error) {
      console.error('❌ Mailgun email sending failed:', {
        error: error.message,
        to: to,
        subject: subject,
        timestamp: new Date().toISOString()
      });
      
      // Check for specific Mailgun errors
      if (error.message.includes('Invalid domain')) {
        throw new Error('Invalid Mailgun domain configuration');
      } else if (error.message.includes('Forbidden')) {
        throw new Error('Invalid Mailgun API key');
      } else if (error.message.includes('parameter is not a valid address')) {
        throw new Error('Invalid email address');
      }
      
      throw error;
    }
  }

  // Test connection
  async testConnection() {
    try {
      // Simple domain verification
      const response = await mg.domains.get(this.domain);
      
      // Handle different response structures
      const domainData = response.domain || response;
      
      if (!domainData) {
        console.error('❌ Mailgun connection failed: Invalid response structure');
        return false;
      }
      
      console.log('✅ Mailgun connection established:', {
        domain: domainData.name || this.domain,
        state: domainData.state || 'unknown',
        createdAt: domainData.created_at || 'unknown'
      });
      return true;
    } catch (error) {
      console.error('❌ Mailgun connection failed:', error.message || error);
      if (error.response) {
        console.error('Error details:', {
          status: error.response.status,
          body: error.response.body
        });
      }
      return false;
    }
  }

  // Verify email address (optional)
  async verifyEmail(email) {
    try {
      const response = await mg.validate.get(email);
      return {
        isValid: response.result === 'deliverable',
        details: response
      };
    } catch (error) {
      console.warn('Email verification failed:', error.message);
      return { isValid: true }; // Assume valid if verification fails
    }
  }
}

// Initialize Mailgun Service
const mailgunService = new MailgunService();

// Test connection on startup
mailgunService.testConnection();

// Add this phone number formatter function
function formatNigerianPhone(phone) {
  // Remove all non-digit characters
  let cleaned = phone.replace(/\D/g, '');

  // Convert local numbers (starts with 0)
  if (cleaned.startsWith('0')) {
    return `+234${cleaned.substring(1)}`;
  }

  // Convert already national numbers (without +234)
  if (cleaned.startsWith('234') && cleaned.length === 13) {
    return `+${cleaned}`;
  }

  // Return as-is if already international format
  return phone;
}

// Sequelize setup
let sequelize;

if (process.env.NODE_ENV === 'production') {
  // Online database (PostgreSQL with SSL for production)
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    ssl: true,
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    },
    pool: {
      max: 20,
      min: 5,
      acquire: 30000,
      idle: 10000
    },
    logging: false
  });
} else {
  // Local database (MySQL or PostgreSQL without SSL)
  sequelize = new Sequelize(
    process.env.DB_NAME || 'your_local_db_name',
    process.env.DB_USER || 'your_local_db_user',
    process.env.DB_PASSWORD || 'your_local_db_password',
    {
      host: process.env.DB_HOST || 'localhost',
      dialect: process.env.DB_DIALECT || 'postgres',
      pool: {
        max: 20,
        min: 5,
        acquire: 30000,
        idle: 10000
      },
    }
  );
}

// Test the connection
(async () => {
  try {
    await sequelize.authenticate();
    console.log('Database connection established successfully.');
  } catch (error) {
    console.error('Unable to connect to the database:', error);
  }
})();

const allowedOrigins = [
  process.env.LOCAL_FRONTEND,
  process.env.LIVE_FRONTEND1,
  process.env.LIVE_FRONTEND2
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log(`❌ Blocked by CORS: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});

// Shareholder Model (existing code remains the same)
const Shareholder = sequelize.define('Shareholder', {
  acno: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  phone_number: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: false,
  },
  holdings: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  address: {
    type: DataTypes.STRING,
    allowNull: true
  },
  email: {
    type: DataTypes.STRING,
    allowNull: true,
    validate: {
      isEmail: true
    }
  },
  chn: {
    type: DataTypes.STRING,
    allowNull: true
  },
  rin: {
    type: DataTypes.STRING,
    allowNull: true
  },
}, {
  tableName: 'shareholders',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  freezeTableName: true
});

// Registered User Model (existing code remains the same)
const RegisteredUser = sequelize.define('registeredusers', {
  name: DataTypes.STRING,
  acno: DataTypes.STRING,
  holdings: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  chn: { type: Sequelize.STRING, allowNull: true },
  email: DataTypes.STRING,
  phone_number: DataTypes.STRING,
  registered_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  sessionId: DataTypes.STRING,
});

const RegisteredHolders = sequelize.define('RegisteredHolders', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  phone_number: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
  },
  shareholding: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  acno: {
    type: DataTypes.STRING,
    allowNull: true
  },
  email: {
    type: DataTypes.STRING,
    allowNull: true,
    validate: {
      isEmail: true
    }
  },
  chn: {
    type: DataTypes.STRING,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('pending', 'active', 'suspended'),
    defaultValue: 'active'
  },
  hasVoted: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  registeredAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    field: 'registered_at'
  }
}, {
  tableName: 'registeredholders',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  hooks: {
    afterCreate: async (holder, options) => {
      await syncHolderToUser(holder);
    },
    afterUpdate: async (holder, options) => {
      await syncHolderToUser(holder);
    }
  }
});

// Helper function to sync data
async function syncHolderToUser(holder) {
  try {
    const userData = {
      name: holder.name,
      acno: holder.acno,
      holdings: holder.shareholding,
      chn: holder.chn,
      email: holder.email,
      phone_number: holder.phone_number,
      registered_at: holder.registeredAt,
    };

    const [user, created] = await RegisteredUser.upsert({
      acno: holder.acno,
      ...userData
    }, {
      returning: true
    });

    console.log(created ? 'Created new user' : 'Updated existing user', user.acno);
  } catch (error) {
    console.error('Error syncing holder to user:', error);
  }
}

// Verification Token Model (existing code remains the same)
const VerificationToken = sequelize.define('VerificationToken', {
  acno: { type: DataTypes.STRING, allowNull: false },
  token: { type: DataTypes.STRING, allowNull: false },
  email: DataTypes.STRING,
  phone_number: DataTypes.STRING,
  chn: { type: Sequelize.STRING, allowNull: true },
  expires_at: { type: DataTypes.DATE, allowNull: false }
}, {
  timestamps: false,
  freezeTableName: true
});

const GuestRegistration = sequelize.define('guest_registrations', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      notEmpty: true
    }
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true,
      notEmpty: true
    }
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      notEmpty: true
    }
  },
  userType: {
    type: DataTypes.ENUM('guest', 'regulator', 'external-auditor'),
    allowNull: false,
    field: 'user_type'
  },
  createdAt: {
    type: DataTypes.DATE,
    field: 'created_at'
  },
  updatedAt: {
    type: DataTypes.DATE,
    field: 'updated_at'
  },
  deletedAt: {
    type: DataTypes.DATE,
    field: 'deleted_at'
  }
}, {
  tableName: 'guest_registrations',
  paranoid: true,
  timestamps: true,
  freezeTableName: true,
});

const RegisteredGuests = GuestRegistration;

// List registered users with pagination and search
app.get('/api/registered-users', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 10, 1), 100);
    const sortBy = ['registered_at', 'name', 'email', 'acno'].includes(req.query.sortBy)
      ? req.query.sortBy
      : 'registered_at';
    const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const search = (req.query.search || '').trim();

    const likeOperator = sequelize.getDialect() === 'postgres' ? Op.iLike : Op.like;

    const whereClause = search
      ? {
          [Op.or]: [
            { name: { [likeOperator]: `%${search}%` } },
            { email: { [likeOperator]: `%${search}%` } },
            { phone_number: { [likeOperator]: `%${search}%` } },
            { acno: { [likeOperator]: `%${search}%` } },
          ],
        }
      : {};

    const { rows, count } = await RegisteredUser.findAndCountAll({
      where: whereClause,
      order: [[sortBy, sortOrder]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    res.json({
      data: rows.map((user) => ({
        id: user.id,
        name: user.name,
        acno: user.acno,
        email: user.email,
        phone_number: user.phone_number,
        // Provide both keys for compatibility with frontend expectations
        shareholding: user.holdings,
        holdings: user.holdings,
        chn: user.chn,
        registered_at: user.registered_at,
      })),
      pagination: {
        page,
        pageSize,
        total: count,
        totalItems: count, // alias for frontend pagination summary
        totalPages: Math.ceil(count / pageSize),
      },
    });
  } catch (error) {
    console.error('Registered users fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch registered users' });
  }
});

// Update the /api/send-confirmation endpoint to use Mailgun
app.post('/api/send-confirmation', async (req, res) => {
  const { acno, email, phone_number } = req.body;

  const formatNigerianPhone = (phone) => {
    if (!phone) return null;
    try {
      const phoneString = String(phone).trim();
      let cleaned = phoneString.replace(/\D/g, '');
      
      if (cleaned.startsWith('0')) {
        return `+234${cleaned.substring(1)}`;
      }
      if (cleaned.startsWith('234') && cleaned.length === 13) {
        return `+${cleaned}`;
      }
      return phoneString;
    } catch (error) {
      console.error('Phone formatting error:', error);
      return null;
    }
  };

  const isValidNigerianPhone = (phone) => {
    return phone && /^\+234[789]\d{9}$/.test(String(phone).trim());
  };

  try {
    // Check if already registered
    const alreadyRegistered = await RegisteredHolders.findOne({ where: { acno } });
    if (alreadyRegistered) {
      return res.status(400).json({ 
        message: '❌ This shareholder is already registered',
        details: { acno }
      });
    }

    // Find shareholder
    const shareholder = await Shareholder.findOne({ where: { acno } });
    if (!shareholder) {
      return res.status(404).json({ 
        message: 'Shareholder not found',
        details: { acno }
      });
    }

    // Update email if provided and different
    if (email && email !== shareholder.email) {
      await Shareholder.update({ email }, { where: { acno } });
      shareholder.email = email;
    }



    // Update phone number if provided
    let finalPhoneNumber = shareholder.phone_number;
    if (phone_number) {
      const formattedPhone = formatNigerianPhone(phone_number);
      if (formattedPhone && isValidNigerianPhone(formattedPhone)) {
        await Shareholder.update({ phone_number: formattedPhone }, { where: { acno } });
        finalPhoneNumber = formattedPhone;
      } else {
        return res.status(400).json({
          message: '❌ Invalid phone number format',
          details: { phone_number }
        });
      }
    }

    // Ensure we have at least one contact method
    if (!shareholder.email && !email && !finalPhoneNumber) {
      return res.status(400).json({
        message: '❌ Either email or phone number is required',
        details: { acno }
      });
    }
    
    // Generate verification token
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes expiry

    await VerificationToken.create({ 
      acno, 
      token, 
      email: email || shareholder.email, 
      phone_number: finalPhoneNumber,
      expires_at: expiresAt 
    });

    const confirmUrl = `https://api.sahco.apel.com.ng/api/confirm/${token}`;

    // Email sending with Mailgun
    let emailSent = false;
    let smsSent = false;

    try {
      const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
       
          <h1 style="color: black; margin: 0;"> Skyway Aviation Handling Company PLC</h1>
          <p style="color: black; margin: 5px 0 0 0;">Extraordinary General Meeting Registration</p>
  
        <div style="padding: 30px 20px;">
          <h2 style="color: #333;">Hello ${shareholder.name},</h2>
          <p>Thank you for registering for the Skyway Aviation Handling Company PLC Extraordinary General Meeting.</p>
          <p>Please click the button below to confirm your registration:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${confirmUrl}" 
               style="background-color: #1075bf; color: white; padding: 15px 30px; 
                      text-decoration: none; border-radius: 5px; font-size: 16px; 
                      font-weight: bold; display: inline-block;">
              ✅ Confirm Registration
            </a>
          </div>
          
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>Account Number:</strong> ${shareholder.acno}</p>
            <p style="margin: 5px 0;"><strong>Email:</strong> ${shareholder.email}</p>
            <p style="margin: 5px 0;"><strong>Link Expires:</strong> ${expiresAt.toLocaleString()}</p>
          </div>

          <div style="background: #0f3d2e; color: #ffffff; padding: 18px 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
            <p style="margin: 0 0 4px 0; font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.8;">Event Details</p>
            <p style="margin: 0; font-size: 18px; font-weight: bold;">Friday, 19th June 2026</p>
            <p style="margin: 4px 0 0 0; font-size: 15px;">11:00 AM</p>
            <p style="margin: 6px 0 0 0; font-size: 13px; opacity: 0.85;">Skyway Aviation Handling Company PLC — Electronic Meeting</p>
          </div>
          
          <p style="color: #666; font-size: 14px;">
            If you did not request this registration, please ignore this email.
          </p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 15px; text-align: center; border-radius: 0 0 10px 10px;">
          <p style="margin: 0; color: #666; font-size: 12px;">
            Skyway Aviation Handling Company PLC © ${new Date().getFullYear()}
          </p>
        </div>
      </div>
    `;

      // Send email using Mailgun
      await mailgunService.sendEmail(
        shareholder.email, 
        'Confirm Your Registration - Skyway Aviation Handling Company PLC AGM', 
        emailHtml
      );
      emailSent = true;
      console.log(`✅ Mailgun email sent to ${shareholder.email}`);

    } catch (emailError) {
      console.error('❌ Mailgun email sending failed:', {
        error: emailError.message,
        email: shareholder.email,
        timestamp: new Date().toISOString()
      });
    }

    // Send SMS if phone number exists
    if (finalPhoneNumber) {
      try {
        const formattedPhone = formatNigerianPhone(finalPhoneNumber);
        
        if (formattedPhone && isValidNigerianPhone(formattedPhone)) {
          await twilioClient.messages.create({
            body: `Hello ${shareholder.name}, confirm Skyway Aviation Handling Company PLC AGM REGISTRATION: ${confirmUrl}`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: formattedPhone
          });
          smsSent = true;
          console.log(`✅ SMS sent to ${formattedPhone}`);
        } else {
          console.warn('Invalid phone number format:', finalPhoneNumber);
        }
      } catch (smsError) {
        console.error('SMS sending failed:', {
          error: smsError.message,
          phone: finalPhoneNumber,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Return appropriate response based on what was sent
    if (emailSent || smsSent) {
      res.json({ 
        success: true,
        message: '✅ Confirmation sent successfully',
        details: {
          email: emailSent ? 'Sent via Mailgun' : 'Failed',
          sms: smsSent ? 'Sent' : finalPhoneNumber ? 'Failed' : 'No phone number'
        }
      });
    } else {
      res.status(500).json({ 
        success: false,
        message: '❌ Failed to send confirmation via both email and SMS',
        details: {
          email: 'Failed',
          sms: finalPhoneNumber ? 'Failed' : 'No phone number'
        }
      });
    }

  } catch (error) {
    console.error('Send confirmation error:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
      requestBody: req.body
    });
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to process registration request',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
    });
  }
});

// Helper function to format shareholder data
function formatShareholder(shareholder) {
  return {
    acno: shareholder.acno,
    name: shareholder.name,
    email: shareholder.email,
    phone_number: shareholder.phone_number,
    holdings: shareholder.holdings,
    chn: shareholder.chn,
    rin: shareholder.rin,
    address: shareholder.address
  };
}

app.post('/api/check-shareholder', async (req, res) => {
  const { searchTerm } = req.body;

  if (!searchTerm || typeof searchTerm !== 'string') {
    return res.status(400).json({ error: 'Please provide a valid search term.' });
  }

  const cleanTerm = searchTerm.trim();

  try {
    // Check for exact account number match first
    if (/^\d+$/.test(cleanTerm)) {
      const shareholder = await Shareholder.findOne({ 
        where: { acno: cleanTerm } 
      });

      if (shareholder) {
        return res.json({
          status: 'account_match',
          shareholder: formatShareholder(shareholder)
        });
      }
    }

    // Check for exact CHN match
    const byChn = await Shareholder.findOne({ 
      where: { 
        chn: { [Op.iLike]: cleanTerm } // Case-insensitive match
      } 
    });

    if (byChn) {
      return res.json({
        status: 'chn_match',
        shareholder: formatShareholder(byChn)
      });
    }

    // Name search - simplified to work with any database
    const shareholders = await Shareholder.findAll({
      where: {
        [Op.or]: [
          // Exact match (case-insensitive)
          { name: { [Op.iLike]: cleanTerm } },
          
          // Starts with term
          { name: { [Op.iLike]: `${cleanTerm}%` } },
          
          // Contains term
          { name: { [Op.iLike]: `%${cleanTerm}%` } },
          
          // Split into words and search for each word
          ...cleanTerm.split(/\s+/).filter(Boolean).map(word => ({
            name: { [Op.iLike]: `%${word}%` }
          }))
        ]
      },
      order: [
        // Prioritize better matches first
        [sequelize.literal(`
          CASE 
            WHEN name ILIKE '${cleanTerm.replace(/'/g, "''")}' THEN 0
            WHEN name ILIKE '${cleanTerm.replace(/'/g, "''")}%' THEN 1
            WHEN name ILIKE '%${cleanTerm.replace(/'/g, "''")}%' THEN 2
            ELSE 3
          END
        `), 'ASC'],
        ['name', 'ASC'] // Secondary sort by name
      ],
      limit: 50
    });

    if (shareholders.length > 0) {
      return res.json({
        status: 'name_matches',
        shareholders: shareholders.map(formatShareholder)
      });
    }

    return res.json({ 
      status: 'not_found', 
      message: 'No matching shareholders found.' 
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ 
      error: 'Internal server error.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update the /api/confirm/:token endpoint to use Mailgun
app.get('/api/confirm/:token', async (req, res) => {
  const { token } = req.params;

  const formatNigerianPhone = (phone) => {
    if (!phone) return null;
    try {
      const phoneString = String(phone).trim();
      let cleaned = phoneString.replace(/\D/g, '');
      
      if (cleaned.startsWith('0')) {
        return `+234${cleaned.substring(1)}`;
      }
      if (cleaned.startsWith('234') && cleaned.length === 13) {
        return `+${cleaned}`;
      }
      return phoneString;
    } catch (error) {
      console.error('Phone formatting error:', error);
      return null;
    }
  };

  const isValidNigerianPhone = (phone) => {
    return phone && /^\+234[789]\d{9}$/.test(String(phone).trim());
  };

  try {
    // Verify token
    const pending = await VerificationToken.findOne({ where: { token } });
    if (!pending || new Date(pending.expires_at) < new Date()) {
      return res.status(400).send(`
        <h1>❌ Invalid or Expired Token</h1>
        <p>The confirmation link has expired or is invalid.</p>
        <p>Please request a new confirmation email.</p>
      `);
    }

    // Get shareholder data
    const shareholder = await Shareholder.findOne({ where: { acno: pending.acno } });
    if (!shareholder) {
      return res.status(404).send(`
        <h1>❌ Shareholder Not Found</h1>
        <p>We couldn't find your shareholder record.</p>
        <p>Please contact support with your ACNO: ${pending.acno}</p>
      `);
    }

    // Complete registration
    await RegisteredHolders.create({
      name: shareholder.name,
      acno: shareholder.acno,
      email: shareholder.email,
      phone_number: shareholder.phone_number || pending.phone_number,
      registered_at: new Date(),
      shareholding: shareholder.holdings,
      chn: shareholder.chn,
      rin: shareholder.rin,
    });

    await pending.destroy();

    // Send success email using Mailgun
    const zoomLink = `https://us06web.zoom.us/j/85474039315`;
    
    const successEmailHtml = `
    <body style="font-family: Arial, sans-serif; background-color: #f6f9fc; padding: 20px; color: #333;">
      <div style="max-width: 600px; margin: auto; background: #ffffff; padding: 25px; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
        
        <h2 style="color:#1075bf; text-align: center;">🎉 Hello ${shareholder.name},</h2>
        
        <p style="font-size: 15px; line-height: 1.6;">
          Your registration for the <strong>Skyway Aviation Handling Company PLC Extraordinary General Meeting</strong> is now complete.
        </p>

        <div style="background: #f1f5f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>📌 ACNO:</strong> ${shareholder.acno}</p>
          <p style="margin: 5px 0;"><strong>📧 Registered Email:</strong> ${shareholder.email}</p>
        </div>

        <div style="background: #0f3d2e; color: #ffffff; padding: 18px 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
          <p style="margin: 0 0 4px 0; font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.8;">Event Details</p>
          <p style="margin: 0; font-size: 18px; font-weight: bold;">Friday, 19th June 2026</p>
          <p style="margin: 4px 0 0 0; font-size: 15px;">11:00 AM</p>
          <p style="margin: 6px 0 0 0; font-size: 13px; opacity: 0.85;">Skyway Aviation Handling Company PLC — Electronic Meeting</p>
        </div>

        <h3 style="color:#1075bf;">Next Steps:</h3>
        <p style="font-size: 15px;">Kindly use the link below to join the upcoming meeting:</p>

        <div style="text-align: center; margin: 20px 0;">
          <a href="${zoomLink}" style="background-color:#1075bf; padding:12px 25px; color:#fff; text-decoration:none; font-weight:bold; border-radius:6px; display:inline-block;">
            ✅ Join Zoom Meeting
          </a>
        </div>

        <p style="font-size: 14px; line-height: 1.6;">
          Please login using your registered email: 
          <strong>${shareholder.email}</strong>
        </p>

        <p style="margin-top: 30px; font-size: 14px; text-align: center; color: #666;">
          Thank you for participating! <br>
          <em>— Skyway Aviation Handling Company PLC Team</em>
        </p>
      </div>
    </body>
    `;

    try {
      await mailgunService.sendEmail(
        shareholder.email,
        '✅ Registration Complete - Skyway Aviation Handling Company PLC AGM',
        successEmailHtml
      );
      console.log(`✅ Registration confirmation email sent via Mailgun to ${shareholder.email}`);
    } catch (emailError) {
      console.error('❌ Failed to send registration confirmation email:', emailError.message);
    }

    // Check if SMS would have been sent
    let smsEligible = false;
    if (shareholder.phone_number) {
      const formattedPhone = formatNigerianPhone(shareholder.phone_number);
      smsEligible = formattedPhone && isValidNigerianPhone(formattedPhone);
      
      if (smsEligible) {
        console.log(`[SMS Simulation] Would have sent to: ${formattedPhone}`);
      }
    }

    // Custom success page with details
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Registration Successful</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 2rem; }
          .success { color: #2ecc71; font-size: 2rem; }
          .details { background: #f8f9fa; padding: 1rem; border-radius: 5px; max-width: 600px; margin: 1rem auto; }
        </style>
      </head>
      <body>
        <div class="success">✅ Registration Successful</div>
        <div class="details">
          <h2>Hello ${shareholder.name}</h2>
          <p>Your registration for the Skyway Aviation Handling Company PLC AGM is complete.</p>
          <p><strong>ACNO:</strong> ${shareholder.acno}</p>
          <p><strong>Email:</strong> ${shareholder.email}</p>
          <p>You will receive meeting details via email before the event.</p>
          <p><em>Email sent via Mailgun</em></p>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Confirmation error:', {
      error: error.message,
      stack: error.stack,
      token,
      timestamp: new Date().toISOString()
    });
    res.status(500).send(`
      <h1>⚠️ Server Error</h1>
      <p>We encountered an error processing your registration.</p>
      <p>Please try again later or contact support.</p>
    `);
  }
});

// Guest registration endpoint
app.post('/api/register-guest', async (req, res) => {
  const { name, email, phone, userType } = req.body;

  if (!name || !email || !phone || !userType) {
    return res.status(400).json({ success: false, error: 'All fields are required' });
  }

  try {
    // Check for duplicate email
    const existing = await GuestRegistration.findOne({ where: { email } });
    if (existing) {
      return res.status(400).json({ success: false, error: 'This email is already registered' });
    }

    const guest = await GuestRegistration.create({ name, email, phone, userType });

    // Send confirmation email
    const typeLabel = { guest: 'Guest', regulator: 'Regulator', 'external-auditor': 'External Auditor' }[userType] || userType;

    const emailHtml = `
    <body style="font-family: Arial, sans-serif; background-color: #f6f9fc; padding: 20px; color: #333;">
      <div style="max-width: 600px; margin: auto; background: #ffffff; padding: 25px; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">

        <h2 style="color: #107b5f; text-align: center;">🎉 Registration Successful!</h2>

        <p style="font-size: 15px; line-height: 1.6;">Dear <strong>${name}</strong>,</p>
        <p style="font-size: 15px; line-height: 1.6;">
          Your registration for the <strong>Skyway Aviation Handling Company PLC Extraordinary General Meeting</strong> has been received and confirmed.
        </p>

        <div style="background: #f1f5f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>Name:</strong> ${name}</p>
          <p style="margin: 5px 0;"><strong>Email:</strong> ${email}</p>
          <p style="margin: 5px 0;"><strong>Attending As:</strong> ${typeLabel}</p>
        </div>

        <div style="background: #0f3d2e; color: #ffffff; padding: 18px 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
          <p style="margin: 0 0 4px 0; font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.8;">Event Details</p>
          <p style="margin: 0; font-size: 18px; font-weight: bold;">Friday, 19th June 2026</p>
          <p style="margin: 4px 0 0 0; font-size: 15px;">11:00 AM</p>
          <p style="margin: 6px 0 0 0; font-size: 13px; opacity: 0.85;">Skyway Aviation Handling Company PLC — Electronic Meeting</p>
        </div>

        <h3 style="color: #107b5f;">What's Next?</h3>
        <p style="font-size: 15px; line-height: 1.6;">
          You will receive a <strong>YouTube live stream link</strong> to watch and attend the EGM closer to the event date. Please keep an eye on your inbox.
        </p>

        <p style="margin-top: 30px; font-size: 14px; text-align: center; color: #666;">
          For enquiries, contact us at <a href="mailto:registrars@apel.com.ng" style="color: #107b5f;">registrars@apel.com.ng</a><br>
          <em>— Apel Capital Registrars Limited</em>
        </p>
      </div>
    </body>
    `;

    try {
      await mailgunService.sendEmail(
        email,
        'Registration Confirmed – Skyway Aviation Handling Company PLC AGM',
        emailHtml
      );
      console.log(`✅ Guest confirmation email sent to ${email}`);
    } catch (emailError) {
      console.error('❌ Guest email failed:', emailError.message);
    }

    res.json({
      success: true,
      message: 'Registration successful. A confirmation email has been sent.',
      guest: {
        id: guest.id,
        name: guest.name,
        email: guest.email,
        phone: guest.phone,
        userType: guest.userType,
      }
    });

  } catch (error) {
    console.error('Guest registration error:', error);
    res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
  }
});

// List registered guests
app.get('/api/registered-guests', async (req, res) => {
  try {
    const page     = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 10, 1), 100);
    const search   = (req.query.search || '').trim();
    const likeOp   = sequelize.getDialect() === 'postgres' ? Op.iLike : Op.like;

    const where = search ? {
      [Op.or]: [
        { name:  { [likeOp]: `%${search}%` } },
        { email: { [likeOp]: `%${search}%` } },
        { phone: { [likeOp]: `%${search}%` } },
      ]
    } : {};

    const { rows, count } = await GuestRegistration.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    res.json({
      data: rows,
      pagination: { page, pageSize, totalItems: count, totalPages: Math.ceil(count / pageSize) }
    });
  } catch (error) {
    console.error('Registered guests fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch registered guests' });
  }
});

// Start server
const PORT = process.env.PORT;
sequelize.sync().then(() => {
  console.log('✅ Database synced');
  app.listen(PORT, () => {
    console.log(`🚀 Server running on ${PORT}`);
  });
});