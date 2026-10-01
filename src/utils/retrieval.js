const { pool } = require('../db');

/**
 * يبحث عن أقرب N نصوص تشريعية دلالياً لمتجه السؤال، ويستبعد أي نص
 * تم إلغاؤه أو تعديله لاحقاً (superseded_by ليس فارغاً) — لتفادي
 * الاستشهاد بقانون ملغى وهو أخطر خطأ ممكن في هذا النوع من الأنظمة.
 */
async function findRelevantLegalTexts(questionEmbedding, limit = 3) {
  const result = await pool.query(
    `SELECT id, source_name, article_ref, content,
            1 - (embedding <=> $1) AS similarity
     FROM legal_texts
     WHERE superseded_by IS NULL
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [JSON.stringify(questionEmbedding), limit]
  );
  return result.rows;
}

module.exports = { findRelevantLegalTexts };
