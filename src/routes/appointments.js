const express = require('express');
const { z } = require('zod');

const { withFirmContext } = require('../db');
const { authenticate, requireRole } = require('../middleware/authenticate');
const { logAudit } = require('../utils/audit');

const router = express.Router();

const createSchema = z.object({
  caseId: z.string().uuid().optional(),
  title: z.string().min(2),
  location: z.string().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(),
  reminderMinutesBefore: z.number().int().min(0).default(60),
});

// ---------------------------------------------------------------
// GET /appointments — مواعيد المكتب القادمة (خلال 90 يوماً افتراضياً)
// ---------------------------------------------------------------
router.get('/', authenticate, async (req, res) => {
  try {
    const rows = await withFirmContext(req.user.firmId, (client) =>
      client.query(
        `SELECT id, title, location, starts_at, ends_at, case_id FROM appointments
         WHERE starts_at BETWEEN now() - interval '1 day' AND now() + interval '90 days'
         ORDER BY starts_at ASC`
      )
    );
    return res.json({ appointments: rows.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'تعذر جلب المواعيد' });
  }
});

// ---------------------------------------------------------------
// POST /appointments — إضافة موعد أو جلسة، للمحامي والمسؤول فقط
// ---------------------------------------------------------------
router.post('/', authenticate, requireRole('lawyer', 'admin'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'بيانات غير صالحة' });
  const { caseId, title, location, startsAt, endsAt, reminderMinutesBefore } = parsed.data;

  try {
    const appt = await withFirmContext(req.user.firmId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO appointments (firm_id, case_id, title, location, starts_at, ends_at, reminder_minutes_before, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, title, starts_at`,
        [req.user.firmId, caseId || null, title, location || null, startsAt, endsAt || null, reminderMinutesBefore, req.user.id]
      );
      await logAudit(client, {
        firmId: req.user.firmId, actorId: req.user.id, action: 'appointment.created',
        targetType: 'appointment', targetId: inserted.rows[0].id, ip: req.ip,
      });
      return inserted.rows[0];
    });
    return res.status(201).json({ appointment: appt });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'تعذر إنشاء الموعد' });
  }
});

module.exports = router;
