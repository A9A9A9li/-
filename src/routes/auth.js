const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');

const { pool, withFirmContext } = require('../db');
const { encryptField, decryptField } = require('../utils/crypto');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// يحدّ من محاولات تخمين كلمة المرور والرموز — 10 محاولات كل 15 دقيقة لكل IP
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

const signupSchema = z.object({
  firmName: z.string().min(2),
  fullName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['lawyer', 'admin']), // العميل يُدعى لاحقاً من داخل المنصة، لا يسجّل نفسه كمكتب جديد
  plan: z.enum(['basic', 'pro', 'enterprise']).default('basic'),
});

// ---------------------------------------------------------------
// POST /auth/signup — إنشاء مكتب جديد + أول مستخدم مسؤول/محامٍ فيه
// ---------------------------------------------------------------
router.post('/signup', authLimiter, async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'بيانات غير صالحة', details: parsed.error.flatten() });
  }
  const { firmName, fullName, email, password, role, plan } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم مسبقاً' });
    }

    const firm = await client.query(
      `INSERT INTO firms (name, subscription_plan) VALUES ($1, $2) RETURNING id`,
      [firmName, plan]
    );
    const firmId = firm.rows[0].id;

    // 12 round من bcrypt — توازن مقبول بين الأمان وزمن الاستجابة
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await client.query(
      `INSERT INTO users (firm_id, full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [firmId, fullName, email, passwordHash, role]
    );
    const userId = user.rows[0].id;

    await logAudit(client, {
      firmId, actorId: userId, action: 'firm.created', targetType: 'firm', targetId: firmId, ip: req.ip,
    });

    await client.query('COMMIT');
    return res.status(201).json({ message: 'تم إنشاء الحساب، يرجى إعداد المصادقة الثنائية قبل أول دخول' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'تعذر إنشاء الحساب' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// POST /auth/mfa/setup — توليد سرّ TOTP وربطه بتطبيق مصادقة (خطوة إلزامية)
// ---------------------------------------------------------------
router.post('/mfa/setup', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT id, firm_id, password_hash FROM users WHERE email = $1', [email]);
  if (result.rowCount === 0) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

  const user = result.rows[0];
  const validPassword = await bcrypt.compare(password || '', user.password_hash);
  if (!validPassword) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

  const secret = speakeasy.generateSecret({ name: `مِيثاق (${email})` });
  const encryptedSecret = encryptField(secret.base32);

  await pool.query('UPDATE users SET mfa_secret_enc = $1 WHERE id = $2', [encryptedSecret, user.id]);

  const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);
  return res.json({ qrCode: qrDataUrl, message: 'امسح الرمز بتطبيق المصادقة ثم فعّله عبر /auth/mfa/confirm' });
});

router.post('/mfa/confirm', authLimiter, async (req, res) => {
  const { email, token } = req.body;
  const result = await pool.query('SELECT id, mfa_secret_enc FROM users WHERE email = $1', [email]);
  if (result.rowCount === 0) return res.status(400).json({ error: 'مستخدم غير موجود' });

  const { id, mfa_secret_enc } = result.rows[0];
  const secret = decryptField(mfa_secret_enc);
  const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 1 });
  if (!verified) return res.status(400).json({ error: 'رمز غير صحيح' });

  await pool.query('UPDATE users SET mfa_enabled = TRUE WHERE id = $1', [id]);
  return res.json({ message: 'تم تفعيل المصادقة الثنائية بنجاح' });
});

// ---------------------------------------------------------------
// POST /auth/login — الخطوة الأولى: البريد وكلمة المرور فقط
// ---------------------------------------------------------------
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query(
    'SELECT id, firm_id, password_hash, role, mfa_enabled, is_active FROM users WHERE email = $1',
    [email]
  );

  // رسالة خطأ موحّدة سواء كان البريد غير موجود أو كلمة المرور خاطئة — يمنع تخمين البريد المسجَّل
  const genericError = () => res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

  if (result.rowCount === 0) return genericError();
  const user = result.rows[0];
  if (!user.is_active) return res.status(403).json({ error: 'الحساب موقوف، تواصل مع مسؤول مكتبك' });

  const validPassword = await bcrypt.compare(password || '', user.password_hash);
  if (!validPassword) return genericError();

  if (!user.mfa_enabled) {
    return res.status(428).json({ error: 'يجب إعداد المصادقة الثنائية أولاً', setupRequired: true });
  }

  // تحدَّى برمز مصادقة ثنائية عبر توكن مؤقت قصير العمر (5 دقائق) بدل إصدار جلسة كاملة الآن
  const mfaChallenge = jwt.sign({ sub: user.id, stage: 'mfa_pending' }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: '5m',
  });
  return res.json({ mfaChallenge, message: 'أدخل رمز المصادقة الثنائية لإكمال الدخول' });
});

// ---------------------------------------------------------------
// POST /auth/login/verify — الخطوة الثانية: تأكيد رمز TOTP وإصدار الجلسة
// ---------------------------------------------------------------
router.post('/login/verify', authLimiter, async (req, res) => {
  const { mfaChallenge, token } = req.body;
  let payload;
  try {
    payload = jwt.verify(mfaChallenge, process.env.JWT_ACCESS_SECRET);
  } catch {
    return res.status(401).json({ error: 'انتهت صلاحية الجلسة المؤقتة، أعد تسجيل الدخول' });
  }
  if (payload.stage !== 'mfa_pending') return res.status(401).json({ error: 'طلب غير صالح' });

  const result = await pool.query('SELECT id, firm_id, role, mfa_secret_enc FROM users WHERE id = $1', [payload.sub]);
  if (result.rowCount === 0) return res.status(401).json({ error: 'مستخدم غير موجود' });

  const user = result.rows[0];
  const secret = decryptField(user.mfa_secret_enc);
  const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 1 });
  if (!verified) return res.status(401).json({ error: 'رمز المصادقة غير صحيح' });

  const accessToken = jwt.sign(
    { sub: user.id, firmId: user.firm_id, role: user.role, stage: 'authenticated' },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '15m' }
  );
  const refreshToken = jwt.sign({ sub: user.id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

  await withFirmContext(user.firm_id, (client) =>
    logAudit(client, { firmId: user.firm_id, actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, ip: req.ip })
  );

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    domain: process.env.COOKIE_DOMAIN,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.json({ accessToken, role: user.role });
});

module.exports = router;
