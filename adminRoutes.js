const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const XLSX = require('xlsx');
const { Op } = require('sequelize');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Auth middleware ─────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.admin = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireSuperAdmin(req, res, next) {
  requireAdmin(req, res, () => {
    if (req.admin.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
    next();
  });
}

// Surface the real DB error message (Sequelize wraps it in err.original)
function dbErr(err) {
  return err?.original?.message || err?.message || String(err);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validId(req, res) {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: `Invalid company ID "${req.params.id}" — must be a UUID` });
    return false;
  }
  return true;
}

// ── Cloudinary multer storage ────────────────────────────────────────────────
const logoStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => ({
    folder: `apel-platform/${req.params.id || 'general'}`,
    public_id: `logo-${Date.now()}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'svg'],
  }),
});
const uploadLogo = multer({ storage: logoStorage });

// ── Meeting-link email template (shared by broadcast + selected-recipient send) ──
function fmtDate(d) {
  if (!d) return 'TBA';
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  }
  return d;
}
function fmtTime(t) {
  if (!t) return '';
  if (/[ap]m/i.test(t)) return t;
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function buildMeetingEmailHtml(company, name) {
  const meetingDate = fmtDate(company.meeting_date);
  const meetingTime = fmtTime(company.meeting_time);
  const zoomLink    = company.zoom_link;
  const youtubeLink = company.youtube_link;
  const fromName    = company.from_name || 'Apel Capital Registrars';

  return `
    <body style="font-family:Arial,sans-serif;background:#f6f9fc;padding:20px;color:#333;">
      <div style="max-width:600px;margin:auto;background:#fff;padding:25px;border-radius:10px;box-shadow:0 4px 10px rgba(0,0,0,.1);">

        <h2 style="color:#0f3d2e;text-align:center;">${company.name}</h2>
        <p style="text-align:center;margin:-10px 0 20px;color:#64748b;font-size:14px;">${company.meeting_type} — Meeting Access Links</p>

        <p style="font-size:15px;line-height:1.6;">Dear <strong>${name}</strong>,</p>
        <p style="font-size:15px;line-height:1.6;">
          Please find below the access links for the upcoming <strong>${company.name} ${company.meeting_type}</strong>.
        </p>

        <div style="background:#f1f5f9;padding:15px;border-radius:8px;margin:20px 0;">
          <p style="margin:5px 0;"><strong>📅 Date:</strong> ${meetingDate}</p>
          ${meetingTime ? `<p style="margin:5px 0;"><strong>🕐 Time:</strong> ${meetingTime}</p>` : ''}
        </div>

        ${zoomLink ? `
        <div style="text-align:center;margin:20px 0;">
          <p style="font-weight:bold;color:#0f3d2e;margin-bottom:8px;">Join / Vote via Zoom</p>
          <a href="${zoomLink}"
             style="background:#0f3d2e;color:#fff;padding:13px 28px;text-decoration:none;border-radius:6px;font-size:15px;font-weight:bold;display:inline-block;">
            🎥 Join Zoom Meeting
          </a>
        </div>` : ''}

        ${youtubeLink ? `
        <div style="text-align:center;margin:20px 0;">
          <p style="font-weight:bold;color:#dc2626;margin-bottom:8px;">Watch Live on YouTube</p>
          <a href="${youtubeLink}"
             style="background:#dc2626;color:#fff;padding:13px 28px;text-decoration:none;border-radius:6px;font-size:15px;font-weight:bold;display:inline-block;">
            ▶ Watch Live Stream
          </a>
        </div>` : ''}

        <p style="margin-top:30px;font-size:13px;text-align:center;color:#64748b;">
          For enquiries contact us at <a href="mailto:registrars@apel.com.ng" style="color:#0f3d2e;">registrars@apel.com.ng</a><br>
          <em>— ${fromName}</em>
        </p>
      </div>
    </body>
  `;
}

// ── Mount routes with models injected ───────────────────────────────────────
module.exports = (models, mailgunService) => {
  const { Company, AdminUser, CompanyShareholder, CompanyRegisteredHolder, CompanyGuest } = models;

  // ── POST /api/admin/login ──────────────────────────────────────────────────
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
      const admin = await AdminUser.findOne({ where: { email } });
      if (!admin || !(await bcrypt.compare(password, admin.password_hash)))
        return res.status(401).json({ error: 'Invalid credentials' });
      const token = jwt.sign(
        { id: admin.id, email: admin.email, role: admin.role, company_id: admin.company_id },
        JWT_SECRET, { expiresIn: '12h' }
      );
      res.json({ token, role: admin.role, company_id: admin.company_id });
    } catch (err) {
      console.error('[login]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── POST /api/admin/seed-superadmin (one-time setup) ──────────────────────
  router.post('/seed-superadmin', async (req, res) => {
    try {
      const { email, password, secret } = req.body;
      if (secret !== process.env.SEED_SECRET) return res.status(403).json({ error: 'Forbidden' });
      const existing = await AdminUser.findOne({ where: { email } });
      if (existing) return res.status(400).json({ error: 'Already exists' });
      const hash = await bcrypt.hash(password, 12);
      const admin = await AdminUser.create({ email, password_hash: hash, role: 'superadmin' });
      res.json({ id: admin.id, email: admin.email, role: admin.role });
    } catch (err) {
      console.error('[seed-superadmin]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── GET /api/admin/companies ───────────────────────────────────────────────
  router.get('/companies', requireAdmin, async (req, res) => {
    try {
      const where = req.admin.role === 'superadmin' ? {} : { id: req.admin.company_id };
      const companies = await Company.findAll({ where, order: [['created_at', 'DESC']] });
      res.json(companies);
    } catch (err) {
      console.error('[GET /companies]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── POST /api/admin/companies ──────────────────────────────────────────────
  router.post('/companies', requireSuperAdmin, async (req, res) => {
    try {
      const company = await Company.create(req.body);
      const json = company.get({ plain: true });
      console.log('[POST /companies] created id:', json.id);
      res.status(201).json(json);
    } catch (err) {
      console.error('[POST /companies]', dbErr(err));
      res.status(400).json({ error: dbErr(err) });
    }
  });

  // ── GET /api/admin/companies/:id ──────────────────────────────────────────
  router.get('/companies/:id', requireAdmin, async (req, res) => {
    if (!validId(req, res)) return;
    try {
      const company = await Company.findByPk(req.params.id);
      if (!company) return res.status(404).json({ error: 'Not found' });
      res.json(company);
    } catch (err) {
      console.error('[GET /companies/:id]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── PUT /api/admin/companies/:id ──────────────────────────────────────────
  router.put('/companies/:id', requireAdmin, async (req, res) => {
    if (!validId(req, res)) return;
    try {
      const company = await Company.findByPk(req.params.id);
      if (!company) return res.status(404).json({ error: 'Not found' });

      const updates = { ...req.body };

      // Track when registration is closed so the landing page can hide stale cards
      if ('is_registration_open' in updates) {
        if (updates.is_registration_open === false || updates.is_registration_open === 'false') {
          if (company.is_registration_open && !company.registration_closed_at) {
            updates.registration_closed_at = new Date();
          }
        } else {
          updates.registration_closed_at = null;
        }
      }

      await company.update(updates);
      res.json(company);
    } catch (err) {
      console.error('[PUT /companies/:id]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── POST /api/admin/companies/:id/logo ────────────────────────────────────
  router.post('/companies/:id/logo', requireAdmin, (req, res, next) => { if (!validId(req, res)) return; next(); }, uploadLogo.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'logo2', maxCount: 1 },
  ]), async (req, res) => {
    try {
      const company = await Company.findByPk(req.params.id);
      if (!company) return res.status(404).json({ error: 'Not found' });
      const updates = {};
      if (req.files?.logo)  updates.logo_url  = req.files.logo[0].path;
      if (req.files?.logo2) updates.logo2_url = req.files.logo2[0].path;
      await company.update(updates);
      res.json({ logo_url: company.logo_url, logo2_url: company.logo2_url });
    } catch (err) {
      console.error('[POST /companies/:id/logo]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── DELETE /api/admin/companies/:id/logo/:which ──────────────────────────
  router.delete('/companies/:id/logo/:which', requireAdmin, async (req, res) => {
    if (!validId(req, res)) return;
    try {
      const company = await Company.findByPk(req.params.id);
      if (!company) return res.status(404).json({ error: 'Not found' });
      const field = req.params.which === 'logo' ? 'logo_url' : 'logo2_url';
      const currentUrl = company[field];
      if (currentUrl) {
        try {
          const after = currentUrl.split('/upload/')[1] || '';
          const pubId = after.replace(/^v\d+\//, '').replace(/\.[^.]+$/, '');
          if (pubId) await cloudinary.uploader.destroy(pubId);
        } catch {}
      }
      await company.update({ [field]: null });
      res.json({ success: true });
    } catch (err) {
      console.error('[DELETE /companies/:id/logo/:which]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── DELETE /api/admin/companies/:id/shareholders ──────────────────────────
  router.delete('/companies/:id/shareholders', requireAdmin, async (req, res) => {
    if (!validId(req, res)) return;
    try {
      const company = await Company.findByPk(req.params.id);
      if (!company) return res.status(404).json({ error: 'Company not found' });
      const deleted = await CompanyShareholder.destroy({ where: { company_id: company.id } });
      console.log(`[clear-shareholders] company=${company.id} deleted=${deleted}`);
      res.json({ success: true, deleted });
    } catch (err) {
      console.error('[DELETE /companies/:id/shareholders]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── POST /api/admin/companies/:id/import-shareholders ─────────────────────
  router.post('/companies/:id/import-shareholders',
    requireAdmin,
    (req, res, next) => { if (!validId(req, res)) return; next(); },
    multer({ storage: multer.memoryStorage() }).single('file'),
    async (req, res) => {
      try {
        const company = await Company.findByPk(req.params.id);
        if (!company) return res.status(404).json({ error: 'Company not found' });

        const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellText: true, cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        // raw:false → use the formatted text Excel displays, not the underlying number
        // This preserves leading zeros when the cell is formatted as Text in Excel
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });

        // Restore a leading zero stripped by Excel from Nigerian phone numbers
        // e.g. 8012345678 (10 digits, starts with 7/8/9) → 08012345678
        function fixPhone(val) {
          const s = String(val || '').trim();
          if (!s) return null;
          if (/^[789]\d{9}$/.test(s)) return `0${s}`;   // 10-digit local, missing leading 0
          if (/^\d{13}$/.test(s) && s.startsWith('234')) return `+${s}`; // 234XXXXXXXXXX → +234...
          return s;
        }

        // Restore leading zeros stripped from account / CHN / RIN numbers
        // Uses the original raw numeric value from the cell when the formatted string lost it
        function fixNumericStr(row, ...keys) {
          for (const key of keys) {
            const raw = row[key];
            if (raw === undefined || raw === null || raw === '') continue;
            return String(raw).trim();
          }
          return '';
        }

        let created = 0, updated = 0, errors = [];

        for (const row of rows) {
          const acno = fixNumericStr(row, 'Account No', 'acno', 'ACNO');
          const name = String(row['Name'] || row['name'] || '').trim();
          if (!acno || !name) { errors.push(`Skipped row: ${JSON.stringify(row)}`); continue; }

          const data = {
            company_id:   company.id,
            acno,
            name,
            email:        String(row['Email'] || row['email'] || '').trim() || null,
            phone_number: fixPhone(row['Phone'] || row['phone'] || row['phone_number']),
            holdings:     parseFloat(String(row['Holdings'] || row['holdings'] || '0').replace(/,/g, '')) || 0,
            chn:          fixNumericStr(row, 'CHN', 'chn') || null,
            rin:          fixNumericStr(row, 'RIN', 'rin') || null,
            address:      String(row['Address'] || row['address'] || '').trim() || null,
          };

          const [, wasCreated] = await CompanyShareholder.upsert(data, { conflictFields: ['company_id', 'acno'] });
          wasCreated ? created++ : updated++;
        }

        res.json({ success: true, created, updated, errors: errors.slice(0, 20) });
      } catch (err) {
        console.error('[import-shareholders]', dbErr(err));
        res.status(400).json({ error: dbErr(err) });
      }
    }
  );

  // ── POST /api/admin/companies/:id/shareholders/single ─────────────────────
  router.post('/companies/:id/shareholders/single', requireAdmin, async (req, res) => {
    if (!validId(req, res)) return;
    try {
      const company = await Company.findByPk(req.params.id);
      if (!company) return res.status(404).json({ error: 'Company not found' });

      const { acno, name, email, phone_number, holdings, chn, rin, address } = req.body;
      if (!acno || !name) return res.status(400).json({ error: 'Account No and Name are required' });

      const [shareholder, created] = await CompanyShareholder.upsert({
        company_id:   company.id,
        acno:         String(acno).trim(),
        name:         String(name).trim(),
        email:        email ? String(email).trim() : null,
        phone_number: phone_number ? String(phone_number).trim() : null,
        holdings:     parseFloat(String(holdings || '0').replace(/,/g, '')) || 0,
        chn:          chn ? String(chn).trim() : null,
        rin:          rin ? String(rin).trim() : null,
        address:      address ? String(address).trim() : null,
      }, { conflictFields: ['company_id', 'acno'], returning: true });

      res.status(created ? 201 : 200).json({ success: true, created, shareholder: shareholder[0] ?? shareholder });
    } catch (err) {
      console.error('[POST /shareholders/single]', dbErr(err));
      res.status(400).json({ error: dbErr(err) });
    }
  });

  // ── GET /api/admin/companies/:id/shareholders ──────────────────────────────
  router.get('/companies/:id/shareholders', requireAdmin, async (req, res) => {
    if (!validId(req, res)) return;
    try {
      const page     = Math.max(parseInt(req.query.page) || 1, 1);
      const pageSize = Math.min(parseInt(req.query.pageSize) || 20, 100);
      const { rows, count } = await CompanyShareholder.findAndCountAll({
        where: { company_id: req.params.id },
        limit: pageSize,
        offset: (page - 1) * pageSize,
        order: [['name', 'ASC']],
      });
      res.json({ data: rows, pagination: { page, pageSize, totalItems: count, totalPages: Math.ceil(count / pageSize) } });
    } catch (err) {
      console.error('[GET /companies/:id/shareholders]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── POST /api/admin/companies/:id/broadcast-email ─────────────────────────
  router.post('/companies/:id/broadcast-email', requireAdmin, async (req, res) => {
    if (!validId(req, res)) return;
    try {
      const company = await Company.findByPk(req.params.id);
      if (!company) return res.status(404).json({ error: 'Company not found' });

      const [holders, guests] = await Promise.all([
        CompanyRegisteredHolder.findAll({ where: { company_id: company.id } }),
        CompanyGuest.findAll({ where: { company_id: company.id } }),
      ]);

      // Collect unique email → name pairs from both lists
      const recipients = new Map();
      for (const h of holders) {
        if (h.email) recipients.set(h.email.toLowerCase(), { name: h.name, email: h.email });
      }
      for (const g of guests) {
        if (g.email) recipients.set(g.email.toLowerCase(), { name: g.name, email: g.email });
      }

      if (recipients.size === 0) {
        return res.status(400).json({ error: 'No registered emails to send to' });
      }

      const fromName = company.from_name || 'Apel Capital Registrars';
      const subject  = `Meeting Access Links — ${company.name} ${company.meeting_type}`;

      let sent = 0, failed = 0;

      for (const { name, email } of recipients.values()) {
        try {
          await mailgunService.sendEmail(email, subject, buildMeetingEmailHtml(company, name), '', fromName);
          sent++;
        } catch (err) {
          console.error(`[broadcast] failed to send to ${email}:`, err.message);
          failed++;
        }
      }

      console.log(`[broadcast] company=${company.id} sent=${sent} failed=${failed}`);
      res.json({ success: true, sent, failed, total: recipients.size });
    } catch (err) {
      console.error('[POST /broadcast-email]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── GET /api/admin/companies/:id/shareholders/search ──────────────────────
  // Typo-tolerant fuzzy search over the full shareholder DB (not just registered
  // ones), so admins can find and pick individual recipients. Uses Postgres
  // pg_trgm similarity when available; falls back to plain ILIKE otherwise.
  router.get('/companies/:id/shareholders/search', requireAdmin, async (req, res) => {
    if (!validId(req, res)) return;
    try {
      const q = (req.query.q || '').trim();
      if (!q) return res.json({ data: [] });

      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const sequelize = CompanyShareholder.sequelize;
      let rows;

      try {
        rows = await sequelize.query(`
          SELECT id, acno, name, email, phone_number, holdings, chn,
                 GREATEST(similarity(name, :q), word_similarity(:q, name)) AS score
          FROM company_shareholders
          WHERE company_id = :companyId
            AND (name % :q OR name ILIKE '%' || :q || '%' OR acno ILIKE '%' || :q || '%' OR email ILIKE '%' || :q || '%')
          ORDER BY score DESC, name ASC
          LIMIT :limit
        `, {
          replacements: { q, companyId: req.params.id, limit },
          type: sequelize.QueryTypes.SELECT,
        });
      } catch (trigramErr) {
        console.warn('[shareholders/search] pg_trgm unavailable, falling back to ILIKE:', dbErr(trigramErr));
        const words = q.split(/\s+/).filter(Boolean);
        rows = await CompanyShareholder.findAll({
          where: {
            company_id: req.params.id,
            [Op.or]: [
              { name:  { [Op.iLike]: `%${q}%` } },
              { acno:  { [Op.iLike]: `%${q}%` } },
              { email: { [Op.iLike]: `%${q}%` } },
              ...words.map(w => ({ name: { [Op.iLike]: `%${w}%` } })),
            ],
          },
          order: [['name', 'ASC']],
          limit,
        });
      }

      res.json({ data: rows });
    } catch (err) {
      console.error('[GET /shareholders/search]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── POST /api/admin/companies/:id/shareholders/send-email ─────────────────
  // Send the meeting-link email to a hand-picked set of shareholders (by id),
  // as opposed to /broadcast-email which sends to everyone already registered.
  router.post('/companies/:id/shareholders/send-email', requireAdmin, async (req, res) => {
    if (!validId(req, res)) return;
    try {
      const company = await Company.findByPk(req.params.id);
      if (!company) return res.status(404).json({ error: 'Company not found' });

      const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.filter(Boolean))] : [];
      if (ids.length === 0) return res.status(400).json({ error: 'No recipients selected' });

      const shareholders = await CompanyShareholder.findAll({
        where: { id: ids, company_id: company.id },
      });
      const recipients = shareholders.filter(s => s.email);

      if (recipients.length === 0) {
        return res.status(400).json({ error: 'None of the selected shareholders have an email on file' });
      }

      const fromName = company.from_name || 'Apel Capital Registrars';
      const subject  = `Meeting Access Links — ${company.name} ${company.meeting_type}`;

      let sent = 0, failed = 0;
      for (const s of recipients) {
        try {
          await mailgunService.sendEmail(s.email, subject, buildMeetingEmailHtml(company, s.name), '', fromName);
          sent++;
        } catch (err) {
          console.error(`[send-email] failed to send to ${s.email}:`, err.message);
          failed++;
        }
      }

      const skippedNoEmail = shareholders.length - recipients.length;
      console.log(`[send-email] company=${company.id} sent=${sent} failed=${failed} skippedNoEmail=${skippedNoEmail}`);
      res.json({ success: true, sent, failed, skippedNoEmail, total: ids.length });
    } catch (err) {
      console.error('[POST /shareholders/send-email]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── GET /api/admin/companies/:id/registrations ────────────────────────────
  router.get('/companies/:id/registrations', requireAdmin, async (req, res) => {
    if (!validId(req, res)) return;
    try {
      const [shareholders, guests] = await Promise.all([
        CompanyRegisteredHolder.findAll({ where: { company_id: req.params.id }, order: [['registered_at', 'DESC']] }),
        CompanyGuest.findAll({ where: { company_id: req.params.id }, order: [['created_at', 'DESC']] }),
      ]);
      res.json({ shareholders, guests });
    } catch (err) {
      console.error('[GET /companies/:id/registrations]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  // ── POST /api/admin/company-admins ────────────────────────────────────────
  router.post('/company-admins', requireSuperAdmin, async (req, res) => {
    try {
      const { email, password, company_id } = req.body;
      const hash = await bcrypt.hash(password, 12);
      const admin = await AdminUser.create({ email, password_hash: hash, role: 'company_admin', company_id });
      res.status(201).json({ id: admin.id, email: admin.email, role: admin.role, company_id: admin.company_id });
    } catch (err) {
      console.error('[POST /company-admins]', dbErr(err));
      res.status(500).json({ error: dbErr(err) });
    }
  });

  return router;
};
