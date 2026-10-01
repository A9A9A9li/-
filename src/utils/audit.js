/**
 * يسجّل حدثاً في audit_logs. يُستدعى بعد أي عملية حساسة (دخول، فتح مستند،
 * اعتماد مسودة...). الجدول نفسه لا يملك أي دور تطبيقي صلاحية UPDATE أو DELETE
 * عليه (انظر schema.sql) — الإدراج فقط.
 */
async function logAudit(client, { firmId, actorId, action, targetType, targetId, ip }) {
  await client.query(
    `INSERT INTO audit_logs (firm_id, actor_id, action, target_type, target_id, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [firmId, actorId || null, action, targetType, targetId || null, ip || null]
  );
}

module.exports = { logAudit };
