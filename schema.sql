-- ============================================================
--   مِيثاق — نموذج قاعدة البيانات (PostgreSQL 15+)
--   يفترض تفعيل: pgcrypto (لتوليد UUID) و Row-Level Security
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1. المكاتب (Firms) — كل مكتب هو "مستأجر" مستقل (Multi-tenant)
-- ------------------------------------------------------------
CREATE TABLE firms (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    subscription_plan TEXT NOT NULL DEFAULT 'basic'   -- basic | pro | enterprise
        CHECK (subscription_plan IN ('basic','pro','enterprise')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 2. المستخدمون والأدوار
-- ------------------------------------------------------------
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firm_id         UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    full_name       TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,          -- تُخزَّن دائماً كـ hash (bcrypt/argon2) وليست نصاً صريحاً
    role            TEXT NOT NULL CHECK (role IN ('lawyer','client','admin')),
    mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_secret_enc  TEXT,                   -- سرّ TOTP مشفّر على مستوى التطبيق قبل التخزين
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_firm ON users(firm_id);
CREATE INDEX idx_users_email ON users(email);

-- ------------------------------------------------------------
-- 3. العملاء (كيان منفصل عن users لأن العميل قد لا يملك حساب دخول)
-- ------------------------------------------------------------
CREATE TABLE clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firm_id         UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL, -- يُملأ إذا كان للعميل حساب دخول
    full_name       TEXT NOT NULL,
    phone           TEXT,
    email           TEXT,
    national_id_enc TEXT,                   -- مشفّر تطبيقياً؛ بيانات هوية حساسة
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_clients_firm ON clients(firm_id);

-- ------------------------------------------------------------
-- 4. القضايا
-- ------------------------------------------------------------
CREATE TABLE cases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firm_id         UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    lead_lawyer_id  UUID NOT NULL REFERENCES users(id),
    title           TEXT NOT NULL,
    case_type       TEXT,                   -- تجاري / إيجارات / جنائي ... إلخ
    stage           TEXT NOT NULL DEFAULT 'intake'
        CHECK (stage IN ('intake','investigation','pleading','judgment','execution','archived')),
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ
);
CREATE INDEX idx_cases_firm ON cases(firm_id);
CREATE INDEX idx_cases_client ON cases(client_id);
CREATE INDEX idx_cases_lawyer ON cases(lead_lawyer_id);

-- سجل زمني لكل تغيّر مرحلة في القضية (Timeline)
CREATE TABLE case_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id     UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,               -- stage_change / note / hearing_scheduled ...
    description TEXT,
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_case_events_case ON case_events(case_id);

-- ------------------------------------------------------------
-- 5. المستندات
-- ------------------------------------------------------------
CREATE TABLE documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firm_id         UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    case_id         UUID REFERENCES cases(id) ON DELETE CASCADE,
    uploaded_by     UUID NOT NULL REFERENCES users(id),
    doc_type        TEXT NOT NULL,          -- contract / memo / ruling / evidence ...
    title           TEXT NOT NULL,
    storage_key     TEXT NOT NULL,          -- مسار الملف في التخزين (S3) — الملف نفسه مشفّر AES-256 عند الراحة
    version         INT NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','pending_review','approved','sent')),
    visible_to_client BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_documents_case ON documents(case_id);
CREATE INDEX idx_documents_firm ON documents(firm_id);

-- صلاحيات دقيقة على مستوى الملف الواحد (تتجاوز صلاحية الدور العامة عند الحاجة)
CREATE TABLE document_permissions (
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_view    BOOLEAN NOT NULL DEFAULT TRUE,
    can_edit    BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (document_id, user_id)
);

-- نتائج فحص المخاطر لعقد معيّن
CREATE TABLE contract_risk_findings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    clause_ref  TEXT,                       -- إشارة إلى البند المعني داخل العقد
    severity    TEXT NOT NULL CHECK (severity IN ('low','mid','high')),
    finding     TEXT NOT NULL,
    reviewed_by UUID REFERENCES users(id),  -- المحامي الذي اعتمد/راجع النتيجة
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_risk_findings_doc ON contract_risk_findings(document_id);

-- ------------------------------------------------------------
-- 6. الجلسات والمواعيد
-- ------------------------------------------------------------
CREATE TABLE appointments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firm_id     UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    case_id     UUID REFERENCES cases(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    location    TEXT,
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ,
    reminder_minutes_before INT DEFAULT 60,
    created_by  UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointments_case ON appointments(case_id);
CREATE INDEX idx_appointments_starts ON appointments(starts_at);

-- ------------------------------------------------------------
-- 7. الفوترة
-- ------------------------------------------------------------
CREATE TABLE invoices (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firm_id     UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    case_id     UUID REFERENCES cases(id),
    client_id   UUID NOT NULL REFERENCES clients(id),
    description TEXT NOT NULL,
    amount      NUMERIC(12,2) NOT NULL,
    currency    TEXT NOT NULL DEFAULT 'SAR',
    status      TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','overdue')),
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at     TIMESTAMPTZ
);
CREATE INDEX idx_invoices_client ON invoices(client_id);

-- ------------------------------------------------------------
-- 8. سجلات التدقيق — غير قابلة للتعديل أو الحذف على مستوى التطبيق
-- ------------------------------------------------------------
CREATE TABLE audit_logs (
    id          BIGSERIAL PRIMARY KEY,
    firm_id     UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    actor_id    UUID REFERENCES users(id),
    action      TEXT NOT NULL,              -- e.g. 'document.view', 'document.approve'
    target_type TEXT NOT NULL,              -- 'document' | 'case' | 'invoice' ...
    target_id   UUID,
    ip_address  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_firm_time ON audit_logs(firm_id, created_at DESC);
-- لا صلاحية UPDATE أو DELETE على هذا الجدول لأي دور تطبيقي — يُمنح فقط INSERT وSELECT

-- ============================================================
--  الأمان: عزل البيانات بين المكاتب عبر Row-Level Security
-- ============================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- مثال سياسة: كل استعلام يمرّ عبر جلسة تحمل current_setting('app.current_firm_id')
-- تضبطها طبقة الـ Backend عند بدء كل اتصال بقاعدة البيانات بعد التحقق من هوية المستخدم.
CREATE POLICY firm_isolation_cases ON cases
    USING (firm_id = current_setting('app.current_firm_id')::UUID);

CREATE POLICY firm_isolation_documents ON documents
    USING (firm_id = current_setting('app.current_firm_id')::UUID);

CREATE POLICY firm_isolation_clients ON clients
    USING (firm_id = current_setting('app.current_firm_id')::UUID);

CREATE POLICY firm_isolation_appointments ON appointments
    USING (firm_id = current_setting('app.current_firm_id')::UUID);

CREATE POLICY firm_isolation_invoices ON invoices
    USING (firm_id = current_setting('app.current_firm_id')::UUID);

CREATE POLICY firm_isolation_audit ON audit_logs
    USING (firm_id = current_setting('app.current_firm_id')::UUID);

-- ملاحظة تنفيذية مهمة:
-- الحقول المنتهية بـ *_enc (مثل national_id_enc، mfa_secret_enc) يجب تشفيرها
-- على مستوى التطبيق (Application-level encryption) قبل الإدراج، وليس فقط
-- الاعتماد على تشفير القرص (Disk-level) — لضمان عدم قراءتها حتى من مسؤول قاعدة البيانات.

-- ============================================================
--   إضافة: قاعدة النصوص التشريعية للبحث الدلالي (RAG)
--   يتطلب تفعيل امتداد pgvector
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE legal_texts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_name     TEXT NOT NULL,          -- اسم القانون/النظام الرسمي
    article_ref     TEXT,                   -- رقم المادة
    content         TEXT NOT NULL,          -- نص المادة كاملاً
    effective_from  DATE,
    superseded_by   UUID REFERENCES legal_texts(id), -- يشير للنص الذي ألغى هذا النص، إن وجد
    embedding       VECTOR(1536),           -- ناتج نموذج التضمين المستخدم للبحث الدلالي
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_legal_texts_embedding ON legal_texts USING ivfflat (embedding vector_cosine_ops);

-- نتيجة تحليل عقد أو استشارة، مربوطة دائماً بالنص التشريعي المصدر
CREATE TABLE chat_citations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firm_id         UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    case_id         UUID REFERENCES cases(id),
    asked_by        UUID NOT NULL REFERENCES users(id),
    question        TEXT NOT NULL,
    answer          TEXT NOT NULL,
    cited_text_id   UUID REFERENCES legal_texts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_citations_firm ON chat_citations(firm_id);

ALTER TABLE chat_citations ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation_chat_citations ON chat_citations
    USING (firm_id = current_setting('app.current_firm_id')::UUID);

-- legal_texts ليست معزولة بـ firm_id عمداً — فهي مصدر تشريعي عام مشترك بين كل المكاتب
