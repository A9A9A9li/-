const jwt = require('jsonwebtoken');

/**
 * يتحقق من رمز الدخول (access token) القصير العمر، ويرفض أي رمز لم يكتمل
 * فيه التحقق الثنائي (stage !== 'authenticated') — حتى لو كان الرمز صالحاً
 * توقيعياً. يضع req.user ليستخدمه أي مسار لاحق عند ضبط app.current_firm_id.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'مطلوب تسجيل الدخول' });

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    if (payload.stage !== 'authenticated') {
      return res.status(401).json({ error: 'الجلسة غير مكتملة' });
    }
    req.user = { id: payload.sub, firmId: payload.firmId, role: payload.role };
    return next();
  } catch {
    return res.status(401).json({ error: 'جلسة منتهية أو غير صالحة' });
  }
}

/**
 * يقيّد مساراً معيّناً بأدوار محددة (مثال: مسارات لوحة المسؤول).
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'لا تملك صلاحية الوصول لهذا المورد' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
