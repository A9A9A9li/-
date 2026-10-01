const { Pool } = require('pg');

// DB_SSL=false يعطّل SSL (مثلاً عند الاتصال عبر شبكة Render الداخلية الخاصة)
const useSsl = process.env.DB_SSL ? process.env.DB_SSL === 'true' : process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  ssl: useSsl ? { rejectUnauthorized: true } : false,
});

/**
 * ينفّذ مجموعة استعلامات ضمن جلسة واحدة بعد ضبط app.current_firm_id،
 * وهو ما تعتمد عليه سياسات Row-Level Security في قاعدة البيانات لعزل
 * بيانات كل مكتب عن الآخر. لا تُستخدم هذه الدالة أبداً بدون تمرير firmId
 * بعد التحقق الفعلي من هوية المستخدم.
 */
async function withFirmContext(firmId, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config محلي بالجلسة (local = true) — لا يتسرّب بين الطلبات المتزامنة
    await client.query('SELECT set_config($1, $2, true)', ['app.current_firm_id', firmId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withFirmContext };
