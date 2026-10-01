/**
 * ملاحظة مهمة: Anthropic لا توفّر نموذج تضمين (embeddings) خاصاً بها،
 * وتُوصي باستخدام Voyage AI لهذا الغرض. لذلك الدالتان أدناه تستدعيان
 * خدمتين مختلفتين: Voyage للتضمين، وAnthropic للإجابة نفسها.
 * ضع كلا المفتاحين في .env قبل الاستخدام الفعلي.
 */

async function getEmbedding(text) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ input: text, model: 'voyage-law-2' }), // نموذج مخصص للنصوص القانونية
  });
  if (!res.ok) throw new Error(`فشل استدعاء خدمة التضمين: ${res.status}`);
  const data = await res.json();
  return data.data[0].embedding;
}

/**
 * يستدعي Claude مع سياق تشريعي مسترجَع فعلياً (RAG)، ويُلزمه بعدم
 * الإجابة إلا استناداً لما وُرِّد له من نصوص، ويطلب صياغة الاستشهاد
 * بأسلوب موحّد ليسهل ربطه بمعرّف النص في قاعدة البيانات لاحقاً.
 */
async function askWithContext(question, legalTexts) {
  const contextBlock = legalTexts
    .map((t, i) => `[مصدر ${i + 1} — ${t.source_name} م.${t.article_ref}]:\n${t.content}`)
    .join('\n\n');

  const systemPrompt = `أنت مساعد بحث تشريعي داخل نظام "مِيثاق". أجب فقط استناداً إلى النصوص
المرفقة أدناه. إن لم تكفِ النصوص المرفقة للإجابة بثقة، صرّح بذلك صراحة ولا تخمّن.
اذكر رقم المصدر [مصدر رقم] الذي استندت إليه في كل جملة قانونية.
ذكّر المستخدم دائماً أن هذه إجابة أولية ولا تُغني عن مراجعة محامٍ مرخّص.

النصوص المتاحة:
${contextBlock}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: question }],
    }),
  });
  if (!res.ok) throw new Error(`فشل استدعاء نموذج اللغة: ${res.status}`);
  const data = await res.json();
  return data.content.map((b) => b.text || '').join('\n');
}

module.exports = { getEmbedding, askWithContext };
