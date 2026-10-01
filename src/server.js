require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const contractsRoutes = require('./routes/contracts');
const casesRoutes = require('./routes/cases');
const documentsRoutes = require('./routes/documents');
const appointmentsRoutes = require('./routes/appointments');

const { ensureSchema } = require('./migrate');

const app = express();

// خلف موازن تحميل (Render وغيره) — ليعمل rate limiting على IP العميل الحقيقي
app.set('trust proxy', 1);

app.use(helmet());                 // رؤوس حماية قياسية (XSS، clickjacking، إلخ)
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// حد عام لكل الـ API لمنع إساءة الاستخدام، منفصل عن الحد الأشد على مسارات المصادقة
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

app.use('/auth', authRoutes);
app.use('/chat', chatRoutes);
app.use('/contracts', contractsRoutes);
app.use('/cases', casesRoutes);
app.use('/documents', documentsRoutes);
app.use('/appointments', appointmentsRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// معالج أخطاء عام — لا يُظهر تفاصيل داخلية للعميل أبداً
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'حدث خطأ غير متوقع' });
});

const PORT = process.env.PORT || 4000;
ensureSchema()
  .then(() => app.listen(PORT, () => console.log(`مِيثاق API يعمل على المنفذ ${PORT}`)))
  .catch((err) => {
    console.error('تعذّر تهيئة قاعدة البيانات', err);
    process.exit(1);
  });
