const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

/**
 * يطبّق schema.sql مرة واحدة عند أول تشغيل إذا كانت قاعدة البيانات فارغة.
 * محلياً يتولى docker-compose ذلك عبر docker-entrypoint-initdb.d، أما على
 * المنصات المُدارة (مثل Render) فلا توجد هذه الآلية، لذا ننفّذه هنا.
 */
async function ensureSchema() {
  const { rows } = await pool.query("SELECT to_regclass('public.firms') AS t");
  if (rows[0].t) return;

  console.log('قاعدة البيانات فارغة — جارٍ تطبيق schema.sql');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ensureSchema };
