import { describe, it, expect } from 'vitest';
import { detectLanguage } from '../../src/server/ai/translation.js';
import { validateSegmentTree } from '../../src/server/ai/segmentSuggest.js';
import { REPORT_METRICS, REPORT_DIMENSIONS } from '../../src/shared/reporting.js';

/**
 * v2.1.0 (M5) unit tests: deterministic language detection (script ranges +
 * stopwords, honest confidence), strict validation of model-generated
 * segment trees (closed kind catalog, depth/node budgets, hostile shapes),
 * and report-catalog integrity (every metric ships a definition - plan
 * Phase 33 requirement).
 */

describe('language detection (Phase 30, deterministic)', () => {
  it('detects Latin-script languages by function words with honest confidence', () => {
    const en = detectLanguage('Hello, I cannot log into my account and the reset email never arrives. Please help me reset the password.');
    expect(en.code).toBe('en');
    expect(en.confidence).toBe('high');
    const es = detectLanguage('Hola, no puedo entrar en mi cuenta y el correo de restablecimiento nunca llega. Por favor, ¿pueden ayudarme con el problema?');
    expect(es.code).toBe('es');
    const fr = detectLanguage("Bonjour, je n'arrive pas à me connecter et je n'ai pas reçu le courriel. Pouvez-vous m'aider s'il vous plaît ?");
    expect(fr.code).toBe('fr');
    const de = detectLanguage('Hallo, ich kann mich nicht anmelden und die E-Mail kommt nicht an. Können Sie mir bitte mit dem Problem helfen?');
    expect(de.code).toBe('de');
  });

  it('detects non-Latin scripts by Unicode ranges', () => {
    expect(detectLanguage('Здравствуйте, я не могу войти в свой аккаунт, пожалуйста помогите мне восстановить доступ к системе.').code).toBe('ru');
    expect(detectLanguage('مرحبا، لا أستطيع تسجيل الدخول إلى حسابي، الرجاء مساعدتي في استعادة كلمة المرور الخاصة بي.').code).toBe('ar');
    expect(detectLanguage('สวัสดีครับ ฉันเข้าสู่ระบบไม่ได้ กรุณาช่วยฉันกู้รหัสผ่านด้วยค่ะ').code).toBe('th');
    expect(detectLanguage('안녕하세요 계정에 로그인할 수 없습니다 비밀번호 재설정을 도와주세요 감사합니다').code).toBe('ko');
    expect(detectLanguage('こんにちは アカウントにログインできません パスワードの再設定を手伝ってください').code).toBe('ja');
  });

  it('reports Han script as Chinese with LOW confidence (shared with Japanese)', () => {
    const zh = detectLanguage('你好 我无法登录我的账户 请帮我重置密码 谢谢');
    expect(zh.code).toBe('zh');
    expect(zh.confidence).toBe('low');
    expect(zh.note).toContain('Han script');
  });

  it('strips URLs, emails and code fences before statistics', () => {
    const d = detectLanguage('Please check https://example.com/docs or write to support@example.com ```{"token": "abc123"}``` the account does not work');
    expect(d.code).toBe('en');
  });

  it('returns honest unknown for empty and unrecognizable text', () => {
    expect(detectLanguage('').confidence).toBe('unknown');
    expect(detectLanguage('1234 5678 9012').code).toBeNull();
    expect(detectLanguage('zzz qwerty uiop').confidence).toBe('unknown');
  });
});

describe('segment tree validation (Phase 31, AI output guard)', () => {
  it('accepts a valid tree and normalizes the combinator', () => {
    const r = validateSegmentTree({ combinator: 'any', conditions: [{ kind: 'contact', field: 'email', op: 'contains', value: 'acme' }], exclude: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tree.combinator).toBe('any');
  });

  it('accepts every new v2.1.0 condition kind', () => {
    const tree = {
      combinator: 'all',
      conditions: [
        { kind: 'organization_property', field: 'name', op: 'contains', value: 'Compute' },
        { kind: 'history_issue', issueKind: 'known_issue', op: 'gte', value: 1 },
        { kind: 'incident_exposure', withinDays: 30 },
        { kind: 'campaign_history', relation: 'received' },
        { kind: 'support_health', metric: 'avg_rating', op: 'gte', value: 4 },
        { kind: 'custom_object_link', typeId: 2 },
        { kind: 'customer_event', eventKind: 'rating', withinDays: 90 },
        { kind: 'ticket', tags: ['billing'], customFields: [{ fieldLocalId: 1, op: 'equals', value: 'x' }], channel: 'email' },
        { kind: 'history', metric: 'waited_over_hours_count', op: 'gte', value: 24 }
      ],
      exclude: [{ kind: 'campaign_history', relation: 'not_received' }]
    };
    const r = validateSegmentTree(tree);
    expect(r.ok).toBe(true);
  });

  it('rejects unknown kinds, hostile shapes and runaway trees', () => {
    expect(validateSegmentTree({ combinator: 'all', conditions: [{ kind: 'drop_table', op: 'x' }], exclude: [] }).ok).toBe(false);
    expect(validateSegmentTree({ combinator: 'all', conditions: [{ kind: 'customer_property', definitionId: -1, op: 'equals' }], exclude: [] }).ok).toBe(false);
    expect(validateSegmentTree({ combinator: 'all', conditions: [{ kind: 'contact', field: 'evil_field', op: 'equals' }], exclude: [] }).ok).toBe(false);
    expect(validateSegmentTree({ combinator: 'all', conditions: [{ kind: 'history', metric: 'no_such_metric', op: 'gte', value: 1 }], exclude: [] }).ok).toBe(false);
    expect(validateSegmentTree({ combinator: 'all', conditions: [{ kind: 'customer_event', eventKind: 'not_a_kind' }], exclude: [] }).ok).toBe(false);
    expect(validateSegmentTree('not an object').ok).toBe(false);
    expect(validateSegmentTree({ combinator: 'all', conditions: null, exclude: [] }).ok).toBe(false);
    // deep nesting refused
    let deep: unknown = { kind: 'contact', field: 'email', op: 'equals' };
    for (let i = 0; i < 12; i++) deep = { kind: 'group', children: [deep] };
    expect(validateSegmentTree({ combinator: 'all', conditions: [deep], exclude: [] }).ok).toBe(false);
    // too many nodes refused
    const many = Array.from({ length: 80 }, () => ({ kind: 'contact', field: 'email', op: 'equals' }));
    expect(validateSegmentTree({ combinator: 'all', conditions: many, exclude: [] }).ok).toBe(false);
  });

  it('rejects AI attribute conditions outside the closed catalog', () => {
    const r = validateSegmentTree({ combinator: 'all', conditions: [{ kind: 'ticket', aiAttribute: { attribute: 'not_in_catalog', op: 'equals', value: 'x' } }], exclude: [] });
    expect(r.ok).toBe(false);
  });
});

describe('report catalog integrity (Phase 33)', () => {
  it('every metric ships a definition and limitations', () => {
    for (const m of REPORT_METRICS) {
      expect(m.definition.length).toBeGreaterThan(20);
      expect(m.limitations.length).toBeGreaterThan(10);
      expect(['count', 'rate', 'minutes', 'hours', 'score']).toContain(m.format);
    }
  });

  it('metric and dimension keys are unique', () => {
    expect(new Set(REPORT_METRICS.map((m) => m.key)).size).toBe(REPORT_METRICS.length);
    expect(new Set(REPORT_DIMENSIONS.map((d) => d.key)).size).toBe(REPORT_DIMENSIONS.length);
  });

  it('covers the plan-required metric families', () => {
    const keys = REPORT_METRICS.map((m) => m.key);
    for (const required of ['conversations', 'unique_customers', 'organizations', 'first_responses', 'agent_replies', 'customer_replies', 'closures', 'avg_wait_hours', 'avg_first_response_minutes', 'avg_resolution_minutes', 'sla_breached', 'avg_state_hours', 'high_priority_rate', 'issue_linked_share', 'ai_attribute_share', 'avg_customer_effort', 'high_friction_rate', 'campaign_reply_rate']) {
      expect(keys).toContain(required);
    }
  });
});
