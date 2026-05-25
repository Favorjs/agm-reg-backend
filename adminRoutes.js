const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const XLSX = require('xlsx');

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
  router.post('/companies/:id/logo', requireAdmin, uploadLogo.fields([
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
    multer({ storage: multer.memoryStorage() }).single('file'),
    async (req, res) => {
      try {
        const company = await Company.findByPk(req.params.id);
        if (!company) return res.status(404).json({ error: 'Company not found' });

        const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

        let created = 0, updated = 0, errors = [];

        for (const row of rows) {
          const acno = String(row['Account No'] || row['acno'] || row['ACNO'] || '').trim();
          const name = String(row['Name'] || row['name'] || '').trim();
          if (!acno || !name) { errors.push(`Skipped row: ${JSON.stringify(row)}`); continue; }

          const data = {
            company_id:   company.id,
            acno,
            name,
            email:        String(row['Email'] || row['email'] || '').trim() || null,
            phone_number: String(row['Phone'] || row['phone'] || row['phone_number'] || '').trim() || null,
            holdings:     parseFloat(row['Holdings'] || row['holdings'] || 0) || 0,
            chn:          String(row['CHN'] || row['chn'] || '').trim() || null,
            rin:          String(row['RIN'] || row['rin'] || '').trim() || null,
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

  // ── GET /api/admin/companies/:id/shareholders ──────────────────────────────
  router.get('/companies/:id/shareholders', requireAdmin, async (req, res) => {
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

  // ── GET /api/admin/companies/:id/registrations ────────────────────────────
  router.get('/companies/:id/registrations', requireAdmin, async (req, res) => {
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
