const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');

function formatPhone(phone) {
  if (!phone) return null;
  let cleaned = String(phone).trim().replace(/\D/g, '');
  if (cleaned.startsWith('0'))   return `+234${cleaned.slice(1)}`;
  if (cleaned.startsWith('234') && cleaned.length === 13) return `+${cleaned}`;
  return phone;
}

function validNigerianPhone(phone) {
  return phone && /^\+234[789]\d{9}$/.test(String(phone).trim());
}

// Formats "2026-06-19" → "Friday, 19 June 2026"; passes through legacy strings unchanged
function fmtDate(d) {
  if (!d) return 'TBA';
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  }
  return d;
}

// Formats "14:00" → "2:00 PM"; passes through legacy "11:00 AM" strings unchanged
function fmtTime(t) {
  if (!t) return '';
  if (/[ap]m/i.test(t)) return t;
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

module.exports = (models, mailgunService, twilioClient) => {
  const {
    Company,
    CompanyShareholder,
    CompanyRegisteredHolder,
    CompanyVerificationToken,
    CompanyGuest,
  } = models;

  // ── GET /api/company/list  (landing page: show all open companies) ──────────
  router.get('/list', async (req, res) => {
    try {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

      const companies = await Company.findAll({
        where: {
          is_active: true,
          [Op.or]: [
            // Open companies — always show
            { is_registration_open: true },
            // Closed but within 5 days of closing — show as "Closed"
            {
              is_registration_open: false,
              registration_closed_at: { [Op.gte]: fiveDaysAgo },
            },
            // Closed with no timestamp yet (legacy rows) — show for 5 days based on updated_at
            {
              is_registration_open: false,
              registration_closed_at: null,
              updated_at: { [Op.gte]: fiveDaysAgo },
            },
          ],
        },
        attributes: ['id', 'slug', 'name', 'meeting_type', 'meeting_date', 'meeting_time',
                     'logo_url', 'primary_color', 'is_registration_open', 'registration_closed_at'],
        order: [
          // Open companies first, then recently closed
          ['is_registration_open', 'DESC'],
          ['name', 'ASC'],
        ],
      });

      res.json(companies.map(c => ({
        ...c.dataValues,
        meeting_date: fmtDate(c.meeting_date),
        meeting_time: fmtTime(c.meeting_time),
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Middleware: resolve company by slug or subdomain ─────────────────────────
  async function resolveCompany(req, res, next) {
    const slug      = req.query.slug      || req.headers['x-company-slug'];
    const subdomain = req.query.subdomain || req.headers['x-company-subdomain'];
    const identifier = slug || subdomain;
    if (!identifier) return res.status(400).json({ error: 'Company identifier required' });

    // In local dev, fall back to the first active company so localhost works
    const isLocal = identifier === 'localhost' || identifier === '127.0.0.1' || identifier === 'dev';
    let where, order;
    if (isLocal) {
      where = { is_active: true };
      order = [['id', 'ASC']];
    } else if (slug) {
      where = { slug, is_active: true };
      order = [];
    } else {
      where = { subdomain, is_active: true };
      order = [];
    }

    const company = await Company.findOne({ where, order });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    req.company = company;
    next();
  }

  // ── GET /api/company/config  (frontend calls this on load) ─────────────────
  router.get('/config', resolveCompany, (req, res) => {
    const c = req.company;
    res.json({
      id:                   c.id,
      slug:                 c.slug,
      name:                 c.name,
      meeting_type:         c.meeting_type,
      meeting_date:         fmtDate(c.meeting_date),
      meeting_time:         fmtTime(c.meeting_time),
      zoom_link:            c.zoom_link,
      youtube_link:         c.youtube_link,
      logo_url:             c.logo_url,
      logo2_url:            c.logo2_url,
      primary_color:        c.primary_color,
      is_registration_open: c.is_registration_open,
    });
  });

  // ── POST /api/company/check-shareholder ────────────────────────────────────
  router.post('/check-shareholder', resolveCompany, async (req, res) => {
    const { searchTerm } = req.body;
    if (!searchTerm?.trim()) return res.status(400).json({ error: 'Search term required' });
    const companyId = req.company.id;
    const clean = searchTerm.trim();

    try {
      // Exact account number
      if (/^\d+$/.test(clean)) {
        const sh = await CompanyShareholder.findOne({ where: { company_id: companyId, acno: clean } });
        if (sh) return res.json({ status: 'account_match', shareholder: sh });
      }

      // CHN match
      const byChn = await CompanyShareholder.findOne({ where: { company_id: companyId, chn: { [Op.iLike]: clean } } });
      if (byChn) return res.json({ status: 'chn_match', shareholder: byChn });

      // Name search
      const byName = await CompanyShareholder.findAll({
        where: {
          company_id: companyId,
          name: { [Op.iLike]: `%${clean}%` },
        },
        order: [['name', 'ASC']],
        limit: 50,
      });
      if (byName.length > 0) return res.json({ status: 'name_matches', shareholders: byName });

      res.json({ status: 'not_found', message: 'No matching shareholders found.' });
    } catch (err) {
      console.error('Search error:', err);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // ── POST /api/company/send-confirmation ────────────────────────────────────
  router.post('/send-confirmation', resolveCompany, async (req, res) => {
    const { acno, email, phone_number } = req.body;
    const company = req.company;

    if (!company.is_registration_open)
      return res.status(403).json({ error: 'Registration is currently closed' });

    try {
      const alreadyDone = await CompanyRegisteredHolder.findOne({ where: { company_id: company.id, acno } });
      if (alreadyDone) return res.status(400).json({ error: 'This shareholder is already registered' });

      const shareholder = await CompanyShareholder.findOne({ where: { company_id: company.id, acno } });
      if (!shareholder) return res.status(404).json({ error: 'Shareholder not found' });

      if (email && email !== shareholder.email) {
        await shareholder.update({ email });
      }

      let finalPhone = shareholder.phone_number;
      if (phone_number) {
        const fmt = formatPhone(phone_number);
        if (!validNigerianPhone(fmt)) return res.status(400).json({ error: 'Invalid Nigerian phone number' });
        await shareholder.update({ phone_number: fmt });
        finalPhone = fmt;
      }

      if (!shareholder.email && !email && !finalPhone)
        return res.status(400).json({ error: 'Email or phone number required' });

      const token    = uuidv4();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      const confirmUrl = `${process.env.API_BASE_URL}/api/company/confirm/${token}`;

      await CompanyVerificationToken.create({
        company_id: company.id, acno, token,
        email: email || shareholder.email,
        phone_number: finalPhone,
        expires_at: expiresAt,
      });

      let emailSent = false;
      const recipientEmail = email || shareholder.email;

      if (recipientEmail) {
        try {
          const html = `
          <body style="font-family: Arial, sans-serif; background: #f6f9fc; padding: 20px; color: #333;">
            <div style="max-width:600px; margin:auto; background:#fff; padding:25px; border-radius:10px;">
              <h2 style="color:${company.primary_color}; text-align:center;">${company.name}</h2>
              <p style="text-align:center; color:#666;">${company.meeting_type} Registration</p>
              <hr style="border:none; border-top:1px solid #eee; margin:20px 0;">
              <p>Dear <strong>${shareholder.name}</strong>,</p>
              <p>Thank you for registering for the <strong>${company.name} ${company.meeting_type}</strong>. Please click below to confirm:</p>
              <div style="text-align:center; margin:30px 0;">
                <a href="${confirmUrl}" style="background:${company.primary_color}; color:#fff; padding:14px 30px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">
                  ✅ Confirm Registration
                </a>
              </div>
              <div style="background:#f1f5f9; padding:15px; border-radius:8px; margin:20px 0;">
                <p style="margin:4px 0;"><strong>Account No:</strong> ${shareholder.acno}</p>
                <p style="margin:4px 0;"><strong>Link expires:</strong> ${expiresAt.toLocaleString()}</p>
              </div>
              <div style="background:${company.primary_color}; color:#fff; padding:15px 20px; border-radius:8px; margin:20px 0; text-align:center;">
                <p style="margin:0 0 4px 0; font-size:12px; opacity:.8; text-transform:uppercase; letter-spacing:.05em;">Event Details</p>
                <p style="margin:0; font-size:17px; font-weight:bold;">${fmtDate(company.meeting_date)}</p>
                <p style="margin:4px 0 0; font-size:14px;">${fmtTime(company.meeting_time)}</p>
              </div>
              <p style="color:#888; font-size:13px; text-align:center;">— Apel Capital Registrars Limited</p>
            </div>
          </body>`;
          await mailgunService.sendEmail(recipientEmail, `Confirm Registration – ${company.name} ${company.meeting_type}`, html);
          emailSent = true;
        } catch (e) { console.error('Email error:', e.message); }
      }

      let smsSent = false;
      if (finalPhone && validNigerianPhone(finalPhone)) {
        try {
          await twilioClient.messages.create({
            body: `${company.name} ${company.meeting_type}: confirm registration → ${confirmUrl}`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to:   finalPhone,
          });
          smsSent = true;
        } catch (e) { console.error('SMS error:', e.message); }
      }

      if (emailSent || smsSent) {
        res.json({ success: true, message: 'Confirmation sent' });
      } else {
        res.status(500).json({ success: false, error: 'Failed to send confirmation' });
      }
    } catch (err) {
      console.error('Send-confirmation error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── GET /api/company/confirm/:token ───────────────────────────────────────
  router.get('/confirm/:token', async (req, res) => {
    try {
      const pending = await CompanyVerificationToken.findOne({ where: { token: req.params.token } });
      if (!pending || new Date(pending.expires_at) < new Date()) {
        return res.status(400).send('<h1>❌ Invalid or expired link</h1><p>Please register again.</p>');
      }

      const company     = await Company.findByPk(pending.company_id);
      const shareholder = await CompanyShareholder.findOne({ where: { company_id: pending.company_id, acno: pending.acno } });
      if (!shareholder) return res.status(404).send('<h1>❌ Shareholder not found</h1>');

      await CompanyRegisteredHolder.create({
        company_id:   pending.company_id,
        acno:         shareholder.acno,
        name:         shareholder.name,
        email:        shareholder.email,
        phone_number: shareholder.phone_number || pending.phone_number,
        holdings:     shareholder.holdings,
        chn:          shareholder.chn,
        registered_at: new Date(),
      });

      await pending.destroy();

      // Success email
      if (shareholder.email) {
        const meetingLink = company.zoom_link || company.youtube_link || '#';
        const linkLabel   = company.zoom_link ? '🎥 Join Zoom Meeting' : '📺 Watch on YouTube';
        const html = `
        <body style="font-family:Arial,sans-serif; background:#f6f9fc; padding:20px; color:#333;">
          <div style="max-width:600px; margin:auto; background:#fff; padding:25px; border-radius:10px;">
            <h2 style="color:${company.primary_color}; text-align:center;">🎉 Registration Complete!</h2>
            <p>Dear <strong>${shareholder.name}</strong>,</p>
            <p>Your registration for the <strong>${company.name} ${company.meeting_type}</strong> is confirmed.</p>
            <div style="background:#f1f5f9; padding:15px; border-radius:8px; margin:20px 0;">
              <p style="margin:4px 0;"><strong>ACNO:</strong> ${shareholder.acno}</p>
              <p style="margin:4px 0;"><strong>Email:</strong> ${shareholder.email}</p>
            </div>
            <div style="background:${company.primary_color}; color:#fff; padding:15px 20px; border-radius:8px; margin:20px 0; text-align:center;">
              <p style="margin:0 0 4px 0; font-size:12px; opacity:.8; text-transform:uppercase;">Event Details</p>
              <p style="margin:0; font-size:17px; font-weight:bold;">${fmtDate(company.meeting_date)}</p>
              <p style="margin:4px 0 0; font-size:14px;">${fmtTime(company.meeting_time)}</p>
            </div>
            <div style="text-align:center; margin:25px 0;">
              <a href="${meetingLink}" style="background:${company.primary_color}; color:#fff; padding:13px 28px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">${linkLabel}</a>
            </div>
            <p style="color:#888; font-size:13px; text-align:center;">— Apel Capital Registrars Limited</p>
          </div>
        </body>`;
        try { await mailgunService.sendEmail(shareholder.email, `✅ Registered – ${company.name} ${company.meeting_type}`, html); } catch {}
      }

      res.send(`<!DOCTYPE html><html><head><title>Registration Complete</title>
        <style>body{font-family:Arial,sans-serif;text-align:center;padding:3rem;background:#f6f9fc;}
        .box{max-width:500px;margin:auto;background:#fff;padding:2rem;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,.08);}
        .icon{font-size:3rem;}</style></head><body>
        <div class="box">
          <div class="icon">✅</div>
          <h2 style="color:${company.primary_color}">Registration Complete</h2>
          <p>Welcome, <strong>${shareholder.name}</strong>.</p>
          <p>You are registered for the <strong>${company.name} ${company.meeting_type}</strong>.</p>
          <p style="color:#888;font-size:13px;">A confirmation email has been sent to ${shareholder.email}.</p>
        </div></body></html>`);
    } catch (err) {
      console.error('Confirm error:', err);
      res.status(500).send('<h1>⚠️ Server Error</h1><p>Please try again or contact support.</p>');
    }
  });

  // ── POST /api/company/register-guest ──────────────────────────────────────
  router.post('/register-guest', resolveCompany, async (req, res) => {
    const company = req.company;
    if (!company.is_registration_open)
      return res.status(403).json({ error: 'Registration is currently closed' });

    const { name, email, phone, userType } = req.body;
    if (!name || !email || !phone || !userType)
      return res.status(400).json({ error: 'All fields are required' });

    try {
      const existing = await CompanyGuest.findOne({ where: { company_id: company.id, email } });
      if (existing) return res.status(400).json({ error: 'Email already registered' });

      const guest = await CompanyGuest.create({ company_id: company.id, name, email, phone, user_type: userType });

      const typeLabel = { guest: 'Guest', regulator: 'Regulator', 'external-auditor': 'External Auditor' }[userType] || userType;
      const streamLink = company.youtube_link || company.zoom_link || null;

      const html = `
      <body style="font-family:Arial,sans-serif; background:#f6f9fc; padding:20px; color:#333;">
        <div style="max-width:600px; margin:auto; background:#fff; padding:25px; border-radius:10px;">
          <h2 style="color:${company.primary_color}; text-align:center;">🎉 Registration Successful!</h2>
          <p>Dear <strong>${name}</strong>,</p>
          <p>Your registration for the <strong>${company.name} ${company.meeting_type}</strong> is confirmed.</p>
          <div style="background:#f1f5f9; padding:15px; border-radius:8px; margin:20px 0;">
            <p style="margin:4px 0;"><strong>Name:</strong> ${name}</p>
            <p style="margin:4px 0;"><strong>Email:</strong> ${email}</p>
            <p style="margin:4px 0;"><strong>Attending As:</strong> ${typeLabel}</p>
          </div>
          <div style="background:${company.primary_color}; color:#fff; padding:15px 20px; border-radius:8px; margin:20px 0; text-align:center;">
            <p style="margin:0 0 4px 0; font-size:12px; opacity:.8; text-transform:uppercase;">Event Details</p>
            <p style="margin:0; font-size:17px; font-weight:bold;">${fmtDate(company.meeting_date)}</p>
            <p style="margin:4px 0 0; font-size:14px;">${fmtTime(company.meeting_time)}</p>
          </div>
          ${streamLink ? `<div style="text-align:center; margin:20px 0;">
            <a href="${streamLink}" style="background:${company.primary_color}; color:#fff; padding:13px 28px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">📺 Watch Live Stream</a>
          </div>` : '<p>You will receive a streaming link closer to the event date.</p>'}
          <p style="color:#888; font-size:13px; text-align:center;">— Apel Capital Registrars Limited</p>
        </div>
      </body>`;

      try {
        await mailgunService.sendEmail(email, `Registration Confirmed – ${company.name} ${company.meeting_type}`, html);
      } catch (e) { console.error('Guest email error:', e.message); }

      res.json({ success: true, guest: { id: guest.id, name, email, phone, userType } });
    } catch (err) {
      console.error('Guest registration error:', err);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  return router;
};
