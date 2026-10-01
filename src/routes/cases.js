const express = require('express');
const { z } = require('zod');

const { withFirmContext } = require('../db');
const { authenticate, requireRole } = require('../middleware/authenticate');
const { logAudit } = require('../utils/audit');

const router = express.Router();

const createCaseSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(2),
  caseType: z.string().optional(),
});

const stageValues = ['intake', 'investigation', 'pleading', 'judgment', 'execution', 'archived'];

// ---------------------------------------------------------------
// GET /cases — القائمة تختلف حسب الدور:
//   محامٍ: قضاياه فقط ما لم يكن مسؤولاً
//   عميل: قضاياه هو فقط، عبر ربط clients.user_id
//   مسؤول: كل قضايا المكتب
// ---------------------------------------------------------------
router.get('/', authenticate, async (req, res) => {
  try {
    const rows = await withFirmContext(req.user.firmId, async (client) => {
      if (req.user.role === 'client') {
        const result = await client.query(
          `SELECT c.id, c.title, c.case_type, c.stage, c.opened_at
           FROM cases c
           JOIN clients cl ON cl.id = c.client_id
           WHERE cl.user_id = $1
           ORDER BY c.opened_at DESC`,
          [req.user.id]
        );
        return result.rows;
      }
      if (req.user.role === 'lawyer') {
        const result = await client.query(
          `SELECT id, title, case_type, stage, opened_at FROM cases
           WHERE lead_lawyer_id = $1 ORDER BY opened_at DESC`,
          [req.user.id]
        );
        return result.rows;
      }
      // admin
      const result = await client.query(
        `SELECT id, title, case_type, stage, opened_at FROM cases ORDER BY opened_at DESC`
      );
      return result.rows;
    });
    return res.json({ cases: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'تعذر جلب القضايا' });
  }
});

// ---------------------------------------------------------------
// POST /cases — إنشاء قضية جديدة، للمحامي والمسؤول فقط
// ---------------------------------------------------------------
router.post('/', authenticate, requireRole('lawyer', 'admin'), async (req, res) => {
  const parsed = createCaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'بيانات غير صالحة' });
  const { clientId, title, caseType } = parsed.data;

  try {
    const newCase = await withFirmContext(req.user.firmId, async (client) => {
      const clientCheck = await client.query('SELECT id FROM clients WHERE id = $1 AND firm_id = $2', [
        clientId, req.user.firmId,
      ]);
      if (clientCheck.rowCount === 0) throw new Error('CLIENT_NOT_FOUND');

      const inserted = await client.query(
        `INSERT INTO cases (firm_id, client_id, lead_lawyer_id, title, case_type)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, title, stage, opened_at`,
        [req.user.firmId, clientId, req.user.id, title, caseType || null]
      );

      await client.query(
        `INSERT INTO case_events (case_id, event_type, description, created_by)
         VALUES ($1, 'stage_change', 'تم فتح الملف', $2)`,
        [inserted.rows[0].id, req.user.id]
      );

      await logAudit(client, {
        firmId: req.user.firmId, actorId: req.user.id, action: 'case.created',
        targetType: 'case', targetId: inserted.rows[0].id, ip: req.ip,
      });

      return inserted.rows[0];
    });
    return res.status(201).json({ case: newCase });
  } catch (err) {
    if (err.message === 'CLIENT_NOT_FOUND') return res.status(404).json({ error: 'العميل غير موجود ضمن مكتبك' });
    console.error(err);
    return res.status(500).json({ error: 'تعذر إنشاء القضية' });
  }
});

// ---------------------------------------------------------------
// GET /cases/:id — تفاصيل قضية واحدة مع سجلها الزمني الكامل
// ---------------------------------------------------------------
router.get('/:id', authenticate, async (req, res) => {
  try {
    const data = await withFirmContext(req.user.firmId, async (client) => {
      const caseResult = await client.query('SELECT * FROM cases WHERE id = $1', [req.params.id]);
      if (caseResult.rowCount === 0) return null;

      // العميل لا يرى قضية إلا إن كانت له فعلاً
      if (req.user.role === 'client') {
        const owns = await client.query(
          `SELECT 1 FROM clients WHERE id = $1 AND user_id = $2`,
          [caseResult.rows[0].client_id, req.user.id]
        );
        if (owns.rowCount === 0) return null;
      }

      const events = await client.query(
        `SELECT event_type, description, created_at FROM case_events
         WHERE case_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      );
      return { ...caseResult.rows[0], timeline: events.rows };
    });

    if (!data) return res.status(404).json({ error: 'القضية غير موجودة أو لا تملك صلاحية الاطلاع عليها' });
    return res.json({ case: data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'تعذر جلب تفاصيل القضية' });
  }
});

// ---------------------------------------------------------------
// PATCH /cases/:id/stage — تحديث مرحلة القضية، للمحامي والمسؤول فقط
// ---------------------------------------------------------------
router.patch('/:id/stage', authenticate, requireRole('lawyer', 'admin'), async (req, res) => {
  const { stage } = req.body;
  if (!stageValues.includes(stage)) return res.status(400).json({ error: 'مرحلة غير معروفة' });

  try {
    const updated = await withFirmContext(req.user.firmId, async (client) => {
      const result = await client.query(
        `UPDATE cases SET stage = $1, closed_at = CASE WHEN $1 = 'archived' THEN now() ELSE closed_at END
         WHERE id = $2 AND firm_id = $3 RETURNING id, stage`,
        [stage, req.params.id, req.user.firmId]
      );
      if (result.rowCount === 0) throw new Error('NOT_FOUND');

      await client.query(
        `INSERT INTO case_events (case_id, event_type, description, created_by)
         VALUES ($1, 'stage_change', $2, $3)`,
        [req.params.id, `تم الانتقال إلى مرحلة: ${stage}`, req.user.id]
      );
      await logAudit(client, {
        firmId: req.user.firmId, actorId: req.user.id, action: 'case.stage_changed',
        targetType: 'case', targetId: req.params.id, ip: req.ip,
      });
      return result.rows[0];
    });
    return res.json({ case: updated });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'القضية غير موجودة ضمن مكتبك' });
    console.error(err);
    return res.status(500).json({ error: 'تعذر تحديث المرحلة' });
  }
});

module.exports = router;
