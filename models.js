const { DataTypes, Sequelize } = require('sequelize');

module.exports = (sequelize) => {

  const Company = sequelize.define('Company', {
    id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    slug:         { type: DataTypes.STRING, allowNull: false, unique: true },  // sahco, lasaco
    subdomain:    { type: DataTypes.STRING, allowNull: true,  unique: true },  // kept for legacy/migration only
    name:         { type: DataTypes.STRING, allowNull: false },
    meeting_type: { type: DataTypes.STRING, defaultValue: 'EGM' },            // AGM | EGM
    meeting_date: { type: DataTypes.STRING, allowNull: true },                 // "Friday, 19th June 2026"
    meeting_time: { type: DataTypes.STRING, allowNull: true },                 // "11:00 AM"
    zoom_link:    { type: DataTypes.TEXT,   allowNull: true },
    youtube_link: { type: DataTypes.TEXT,   allowNull: true },
    logo_url:     { type: DataTypes.TEXT,   allowNull: true },                 // Cloudinary URL
    logo2_url:    { type: DataTypes.TEXT,   allowNull: true },                 // second logo
    primary_color:{ type: DataTypes.STRING, defaultValue: '#107b5f' },
    from_name:    { type: DataTypes.STRING, defaultValue: 'Apel Capital Registrars' },
    is_registration_open:   { type: DataTypes.BOOLEAN, defaultValue: false },
    registration_closed_at: { type: DataTypes.DATE,    allowNull: true },  // set when registration is closed
    is_active:    { type: DataTypes.BOOLEAN, defaultValue: true },
  }, {
    tableName: 'companies',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  const AdminUser = sequelize.define('AdminUser', {
    id:            { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    email:         { type: DataTypes.STRING, allowNull: false, unique: true },
    password_hash: { type: DataTypes.STRING, allowNull: false },
    role:          { type: DataTypes.ENUM('superadmin', 'company_admin'), defaultValue: 'company_admin' },
    company_id:    { type: DataTypes.UUID, allowNull: true },  // null = superadmin (all companies)
  }, {
    tableName: 'admin_users',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  // Scoped shareholder list per company (separate from existing legacy table)
  const CompanyShareholder = sequelize.define('CompanyShareholder', {
    id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    company_id:   { type: DataTypes.UUID, allowNull: false },
    acno:         { type: DataTypes.STRING, allowNull: false },
    name:         { type: DataTypes.STRING, allowNull: false },
    email:        { type: DataTypes.STRING, allowNull: true },
    phone_number: { type: DataTypes.STRING, allowNull: true },
    holdings:     { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    chn:          { type: DataTypes.STRING, allowNull: true },
    rin:          { type: DataTypes.STRING, allowNull: true },
    address:      { type: DataTypes.STRING, allowNull: true },
  }, {
    tableName: 'company_shareholders',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [{ unique: true, fields: ['company_id', 'acno'] }],
  });

  const CompanyRegisteredHolder = sequelize.define('CompanyRegisteredHolder', {
    id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    company_id:   { type: DataTypes.UUID, allowNull: false },
    acno:         { type: DataTypes.STRING, allowNull: true },
    name:         { type: DataTypes.STRING, allowNull: false },
    email:        { type: DataTypes.STRING, allowNull: true },
    phone_number: { type: DataTypes.STRING, allowNull: true },
    holdings:     { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    chn:          { type: DataTypes.STRING, allowNull: true },
    registered_at:{ type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'company_registered_holders',
    timestamps: false,
  });

  const CompanyVerificationToken = sequelize.define('CompanyVerificationToken', {
    id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    company_id:   { type: DataTypes.UUID, allowNull: false },
    acno:         { type: DataTypes.STRING, allowNull: false },
    token:        { type: DataTypes.STRING, allowNull: false, unique: true },
    email:        { type: DataTypes.STRING, allowNull: true },
    phone_number: { type: DataTypes.STRING, allowNull: true },
    chn:          { type: DataTypes.STRING, allowNull: true },
    expires_at:   { type: DataTypes.DATE, allowNull: false },
  }, {
    tableName: 'company_verification_tokens',
    timestamps: false,
  });

  const CompanyGuest = sequelize.define('CompanyGuest', {
    id:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    company_id: { type: DataTypes.UUID, allowNull: false },
    name:       { type: DataTypes.STRING, allowNull: false },
    email:      { type: DataTypes.STRING, allowNull: false },
    phone:      { type: DataTypes.STRING, allowNull: false },
    user_type:  { type: DataTypes.ENUM('guest', 'regulator', 'external-auditor'), allowNull: false },
  }, {
    tableName: 'company_guests',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [{ unique: true, fields: ['company_id', 'email'] }],
  });

  // Associations
  Company.hasMany(CompanyShareholder,       { foreignKey: 'company_id' });
  Company.hasMany(CompanyRegisteredHolder,  { foreignKey: 'company_id' });
  Company.hasMany(CompanyGuest,             { foreignKey: 'company_id' });
  Company.hasMany(CompanyVerificationToken, { foreignKey: 'company_id' });
  Company.hasMany(AdminUser,                { foreignKey: 'company_id' });

  return {
    Company,
    AdminUser,
    CompanyShareholder,
    CompanyRegisteredHolder,
    CompanyVerificationToken,
    CompanyGuest,
  };
};
