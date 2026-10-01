const express = require('express');
const { z } = require('zod');

const { withFirmContext } = require('../db');
const { authenticate, requireRole } = require('../middleware/authenticate');
const { logAudit } = require('../utils/audit');

const router = express.Router();

const analyzeSchema = z.object({
  documentId: z.string().uuid(),
  contractText: z.string().min(50), // النص المستخرَج من ملف العقد (عبر خطوة OCR/parsing سابقة خارج نطاق هذا المسار)
});

/**
 * يطلب من نموذج اللغة استخراج البنود الجوهرية وتصنيف كل بند حسب درجة
 * الخطورة، بصيغة JSON منضبطة يسهل تخزينها مباشرة في contract_risk_findings.
 * لا يُعتمد أي ناتج تلقائياً — يبقى بحالة "بانتظار مراجعة محامٍ" دائماً.
 */
async function extractRiskFindings(contractText) {
  const systemPrompt = `أنت محلل عقود. اقرأ نص العقد التالي واستخرج قائمة JSON فقط بدون أي نص إضافي،
كل عنصر بالشكل: {"clause_ref": "...", "severity": "low|mid|high", "finding": "..."}.
لا تُصدر أكثر من 10 عناصر، وركّز على: التعويضات غير المتماثلة، غموض مدد الإخطار،
القانون الواجب التطبيق، وشروط الإنهاء المجحفة.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: contractText }],
    }),
  });
  if (!res.ok) throw new Error(`فشل استدعاء نموذج اللغة: ${res.status}`);
  const data = await res.json();
  const rawText = data.content.map((b) => b.text || '').join('').trim();

  try {
    return JSON.parse(rawText.replace(/```json|```/g, '').trim());
  } catch {
    throw new Error('تعذّر تفسير ناتج التحليل كـ JSON صالح');
  }
}

// ---------------------------------------------------------------
// POST /contracts/analyze — يشغّله محامٍ أو مسؤول فقط، وليس العميل
// ---------------------------------------------------------------
router.post('/analyze', authenticate, requireRole('lawyer', 'admin'), async (req, res) => {
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'بيانات غير صالحة' });
  const { documentId, contractText } = parsed.data;

  try {
    const findings = await extractRiskFindings(contractText);

    const saved = await withFirmContext(req.user.firmId, async (client) => {
      // تأكيد أن المستند فعلاً يتبع لنفس مكتب المستخدم قبل أي إدراج (تدافع مضاعف مع RLS)
      const doc = await client.query(
        'SELECT id FROM documents WHERE id = $1 AND firm_id = $2',
        [documentId, req.user.firmId]
      );
      if (doc.rowCount === 0) throw new Error('NOT_FOUND');

      const rows = [];
      for (const f of findings) {
        const inserted = await client.query(
          `INSERT INTO contract_risk_findings (document_id, clause_ref, severity, finding)
           VALUES ($1, $2, $3, $4) RETURNING id, clause_ref, severity, finding`,
          [documentId, f.clause_ref, f.severity, f.finding]
        );
        rows.push(inserted.rows[0]);
      }

      // العقد يبقى "بانتظار المراجعة" حتى لو اكتمل الفحص الآلي — لا اعتماد تلقائي أبداً
      await client.query(
        `UPDATE documents SET status = 'pending_review' WHERE id = $1`,
        [documentId]
      );

      await logAudit(client, {
        firmId: req.user.firmId, actorId: req.user.id, action: 'contract.analyzed',
        targetType: 'document', targetId: documentId, ip: req.ip,
      });

      return rows;
    });

    return res.json({
      findings: saved,
      status: 'pending_review',
      note: 'التحليل أولي بالكامل. يجب على محامٍ اعتماد المستند صراحة قبل مشاركته مع العميل.',
    });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'المستند غير موجود ضمن مكتبك' });
    console.error(err);
    return res.status(502).json({ error: 'تعذر إكمال التحليل حالياً' });
  }
});

// ---------------------------------------------------------------
// POST /contracts/:documentId/approve — اعتماد بشري صريح ينقل حالة المستند إلى approved
// ---------------------------------------------------------------
router.post('/:documentId/approve', authenticate, requireRole('lawyer', 'admin'), async (req, res) => {
  const { documentId } = req.params;
  try {
    await withFirmContext(req.user.firmId, async (client) => {
      const result = await client.query(
        `UPDATE documents SET status = 'approved'
         WHERE id = $1 AND firm_id = $2 AND status = 'pending_review'
         RETURNING id`,
        [documentId, req.user.firmId]
      );
      if (result.rowCount === 0) throw new Error('NOT_FOUND_OR_WRONG_STATE');

      await logAudit(client, {
        firmId: req.user.firmId, actorId: req.user.id, action: 'contract.approved',
        targetType: 'document', targetId: documentId, ip: req.ip,
      });
    });
    return res.json({ message: 'تم اعتماد المستند، وأصبح قابلاً للمشاركة مع العميل' });
  } catch (err) {
    if (err.message === 'NOT_FOUND_OR_WRONG_STATE') {
      return res.status(409).json({ error: 'المستند غير موجود أو ليس بحالة قابلة للاعتماد' });
    }
    console.error(err);
    return res.status(500).json({ error: 'تعذر اعتماد المستند' });
  }
});

module.exports = router;
