const express = require('express');
const { z } = require('zod');

const { withFirmContext } = require('../db');
const { authenticate, requireRole } = require('../middleware/authenticate');
const { logAudit } = require('../utils/audit');

const router = express.Router();

const createDocSchema = z.object({
  caseId: z.string().uuid(),
  docType: z.string().min(2),
  title: z.string().min(2),
  storageKey: z.string().min(3), // مسار الملف بعد رفعه المباشر إلى التخزين (S3) من الواجهة
});

// ---------------------------------------------------------------
// GET /documents?caseId=... — العميل يرى فقط ما وُسم visible_to_client = true
// ---------------------------------------------------------------
router.get('/', authenticate, async (req, res) => {
  const { caseId } = req.query;
  if (!caseId) return res.status(400).json({ error: 'معرّف القضية مطلوب' });

  try {
    const rows = await withFirmContext(req.user.firmId, async (client) => {
      if (req.user.role === 'client') {
        const owns = await client.query(
          `SELECT 1 FROM cases c JOIN clients cl ON cl.id = c.client_id
           WHERE c.id = $1 AND cl.user_id = $2`,
          [caseId, req.user.id]
        );
        if (owns.rowCount === 0) throw new Error('FORBIDDEN');

        const result = await client.query(
          `SELECT id, title, doc_type, status, created_at FROM documents
           WHERE case_id = $1 AND visible_to_client = TRUE ORDER BY created_at DESC`,
          [caseId]
        );
        return result.rows;
      }

      const result = await client.query(
        `SELECT id, title, doc_type, status, version, visible_to_client, created_at
         FROM documents WHERE case_id = $1 ORDER BY created_at DESC`,
        [caseId]
      );
      return result.rows;
    });
    return res.json({ documents: rows });
  } catch (err) {
    if (err.message === 'FORBIDDEN') return res.status(403).json({ error: 'لا تملك صلاحية الاطلاع على هذه القضية' });
    console.error(err);
    return res.status(500).json({ error: 'تعذر جلب المستندات' });
  }
});

// ---------------------------------------------------------------
// POST /documents — تسجيل مستند بعد رفعه (المحامي والمسؤول فقط)
// ---------------------------------------------------------------
router.post('/', authenticate, requireRole('lawyer', 'admin'), async (req, res) => {
  const parsed = createDocSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'بيانات غير صالحة' });
  const { caseId, docType, title, storageKey } = parsed.data;

  try {
    const doc = await withFirmContext(req.user.firmId, async (client) => {
      const caseCheck = await client.query('SELECT id FROM cases WHERE id = $1 AND firm_id = $2', [
        caseId, req.user.firmId,
      ]);
      if (caseCheck.rowCount === 0) throw new Error('CASE_NOT_FOUND');

      const inserted = await client.query(
        `INSERT INTO documents (firm_id, case_id, uploaded_by, doc_type, title, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, title, status, created_at`,
        [req.user.firmId, caseId, req.user.id, docType, title, storageKey]
      );

      await logAudit(client, {
        firmId: req.user.firmId, actorId: req.user.id, action: 'document.uploaded',
        targetType: 'document', targetId: inserted.rows[0].id, ip: req.ip,
      });
      return inserted.rows[0];
    });
    return res.status(201).json({ document: doc });
  } catch (err) {
    if (err.message === 'CASE_NOT_FOUND') return res.status(404).json({ error: 'القضية غير موجودة ضمن مكتبك' });
    console.error(err);
    return res.status(500).json({ error: 'تعذر تسجيل المستند' });
  }
});

// ---------------------------------------------------------------
// PATCH /documents/:id/share — إتاحة مستند معتمد فقط للعميل (لا تُتاح المسودات أبداً)
// ---------------------------------------------------------------
router.patch('/:id/share', authenticate, requireRole('lawyer', 'admin'), async (req, res) => {
  try {
    const result = await withFirmContext(req.user.firmId, (client) =>
      client.query(
        `UPDATE documents SET visible_to_client = TRUE
         WHERE id = $1 AND firm_id = $2 AND status = 'approved'
         RETURNING id`,
        [req.params.id, req.user.firmId]
      )
    );
    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'لا يمكن مشاركة مستند لم يُعتمد بعد' });
    }
    return res.json({ message: 'تمت مشاركة المستند مع العميل' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'تعذرت مشاركة المستند' });
  }
});

module.exports = router;
