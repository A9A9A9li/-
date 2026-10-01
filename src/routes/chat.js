const express = require('express');
const { z } = require('zod');

const { withFirmContext } = require('../db');
const { authenticate } = require('../middleware/authenticate');
const { getEmbedding, askWithContext } = require('../utils/llm');
const { findRelevantLegalTexts } = require('../utils/retrieval');
const { logAudit } = require('../utils/audit');

const router = express.Router();

const askSchema = z.object({
  question: z.string().min(3).max(2000),
  caseId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------
// POST /chat/ask — سؤال قانوني: استرجاع النصوص ذات الصلة أولاً، ثم الإجابة استناداً إليها فقط
// ---------------------------------------------------------------
router.post('/ask', authenticate, async (req, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'سؤال غير صالح' });
  const { question, caseId } = parsed.data;

  try {
    const questionEmbedding = await getEmbedding(question);
    const relevantTexts = await findRelevantLegalTexts(questionEmbedding, 3);

    if (relevantTexts.length === 0) {
      return res.json({
        answer: 'لا تتوفر لدي نصوص تشريعية مفهرسة كافية للإجابة بثقة على هذا السؤال. يُفضّل مراجعة محامٍ مباشرة.',
        sources: [],
      });
    }

    const answer = await askWithContext(question, relevantTexts);

    await withFirmContext(req.user.firmId, async (client) => {
      await client.query(
        `INSERT INTO chat_citations (firm_id, case_id, asked_by, question, answer, cited_text_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.user.firmId, caseId || null, req.user.id, question, answer, relevantTexts[0].id]
      );
      await logAudit(client, {
        firmId: req.user.firmId, actorId: req.user.id, action: 'chat.ask', targetType: 'chat_citations',
      });
    });

    return res.json({
      answer,
      sources: relevantTexts.map((t) => ({ source: t.source_name, article: t.article_ref, similarity: t.similarity })),
      disclaimer: 'إجابة أولية لأغراض الاستكشاف، لا تُغني عن مراجعة محامٍ مرخّص.',
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'تعذر الحصول على إجابة موثوقة حالياً' });
  }
});

module.exports = router;
