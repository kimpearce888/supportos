import type { DB } from '../database/connection.js';
import { createHash } from 'node:crypto';
import type { ChatMessage } from '../integrations/lmstudio/lmStudioClient.js';
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES } from '../../shared/translation.js';
import type { ConversationLanguageSummary, LanguageDetection, TranslationPurpose, TranslationResult } from '../../shared/translation.js';
import { htmlToText } from '../../shared/utils.js';

/**
 * Local translation service (v2.1.0, plan Phase 30).
 *
 * - Detection is DETERMINISTIC: script ranges first (Chinese/Japanese/Korean/
 *   Arabic/Devanagari/Thai/Greek/Hebrew/Cyrillic), then stopword-frequency
 *   scoring for Latin-script languages. Confidence and method are reported
 *   honestly; 'unknown' is a legitimate result. Detection never calls a model.
 * - Translation runs ONLY through the local LM Studio endpoint (injectable
 *   chat function - the CopilotService pattern). No cloud translation.
 * - Results are cached by sha256(source|target|purpose|text): identical
 *   requests never re-run the model.
 * - The system prompt instructs the model to preserve technical terms,
 *   product names, code, URLs and email addresses verbatim.
 * - Nothing is ever sent automatically: the caller receives the translation
 *   for side-by-side review; sends still go through the human write path.
 */

export type TranslateChatFn = (opts: { messages: ChatMessage[]; temperature?: number; maxTokens?: number }) => Promise<{ content: string | null; model: string; latencyMs: number }>;

// ---- deterministic detection -------------------------------------------------

const SCRIPT_RANGES: { code: string; ranges: [number, number][]; confidence: 'high' | 'medium' | 'low' }[] = [
  // Hangul before Han: Korean text is dominated by Hangul syllables.
  { code: 'ko', ranges: [[0xac00, 0xd7a3]], confidence: 'medium' },
  // Kana (Hiragana + Katakana) - unique to Japanese.
  { code: 'ja', ranges: [[0x3040, 0x30ff]], confidence: 'medium' },
  // Han script: shared; reported as Chinese with script-level confidence.
  { code: 'zh', ranges: [[0x4e00, 0x9fff], [0x3400, 0x4dbf]], confidence: 'low' },
  { code: 'ru', ranges: [[0x0400, 0x04ff]], confidence: 'high' },
  { code: 'el', ranges: [[0x0370, 0x03ff]], confidence: 'high' },
  { code: 'he', ranges: [[0x0590, 0x05ff]], confidence: 'high' },
  { code: 'ar', ranges: [[0x0600, 0x06ff]], confidence: 'high' },
  { code: 'hi', ranges: [[0x0900, 0x097f]], confidence: 'high' },
  { code: 'th', ranges: [[0x0e00, 0x0e7f]], confidence: 'high' }
];

/** Top function words per Latin-script language (deterministic scoring). */
const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'are', 'was', 'you', 'for', 'with', 'that', 'this', 'have', 'not', 'but', 'can', 'how', 'what', 'when', 'why', 'please', 'thank', 'we', 'our', 'your', 'it', 'my', 'do', 'does', 'did', 'has', 'had', 'will', 'would', 'could', 'should', 'from', 'about'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'por', 'con', 'para', 'no', 'se', 'lo', 'su', 'más', 'está', 'estoy', 'hola', 'gracias', 'cómo', 'qué', 'cuando', 'dónde', 'puedo', 'necesito', 'favor'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'en', 'un', 'une', 'du', 'que', 'qui', 'pour', 'avec', 'dans', 'pas', 'est', 'je', 'vous', 'nous', 'merci', 'bonjour', 'comment', 'pourquoi', 'peux', 'avez', 'être'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'ein', 'eine', 'auf', 'von', 'ich', 'sie', 'wir', 'und', 'auch', 'als', 'wie', 'danke', 'bitte', 'hallo', 'können', 'haben', 'sehr', 'warum'],
  it: ['il', 'lo', 'la', 'le', 'di', 'che', 'e', 'in', 'un', 'una', 'per', 'con', 'non', 'sono', 'ho', 'mi', 'si', 'come', 'grazie', 'ciao', 'perché', 'quando', 'posso', 'molto', 'anche', 'dove'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'em', 'um', 'uma', 'para', 'com', 'não', 'por', 'do', 'da', 'estou', 'você', 'obrigado', 'olá', 'como', 'por', 'quando', 'posso', 'muito', 'também'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'met', 'voor', 'ik', 'wij', 'jullie', 'heb', 'hebben', 'kan', 'niet', 'dank', 'hallo', 'hoe', 'waarom', 'want', 'ook', 'maar', 'nog', 'wel'],
  pl: ['nie', 'jest', 'się', 'na', 'że', 'do', 'mam', 'jak', 'ale', 'czy', 'dziękuję', 'cześć', 'dlaczego', 'kiedy', 'można', 'bardzo', 'proszę', 'jeśli', 'tego', 'dla', 'od', 'przy', 'bez'],
  tr: ['bir', 've', 'bu', 'için', 'ile', 'değil', 'mi', 'my', 'nasıl', 'teşekkür', 'merhaba', 'neden', 'ne', 'zaman', 'olabilir', 'çok', 'ama', 'gerekli', 'lütfen', 'var', 'yok', 'olarak'],
  sv: ['och', 'att', 'det', 'en', 'som', 'är', 'för', 'med', 'inte', 'har', 'den', 'jag', 'vi', 'ni', 'tack', 'hej', 'hur', 'varför', 'när', 'kan', 'mycket', 'också', 'men', 'om'],
  vi: ['của', 'và', 'là', 'có', 'không', 'được', 'cho', 'với', 'này', 'tôi', 'bạn', 'chúng', 'cảm ơn', 'xin', 'làm', 'thế nào', 'tại sao', 'khi', 'có thể', 'rất', 'nhưng']
};

export function detectLanguage(text: string): LanguageDetection {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    return { text: trimmed, code: null, name: null, confidence: 'unknown', method: 'empty', alternatives: [], note: 'No text to analyze.' };
  }
  // Strip URLs, emails, code fences and long digit runs so technical noise
  // does not skew script/stopword statistics.
  const cleaned = trimmed
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\b[a-f0-9]{8,}\b/gi, ' ');
  const chars = [...cleaned];
  const letterCount = chars.filter((ch) => /[a-z0-9\u00c0-\uffff]/i.test(ch)).length;
  if (letterCount < 3) {
    return { text: trimmed, code: null, name: null, confidence: 'unknown', method: 'empty', alternatives: [], note: 'Not enough recognizable characters to detect a language.' };
  }

  // 1) Script ranges (weighted by share of script letters).
  const scriptScores: { code: string; share: number; confidence: 'high' | 'medium' | 'low' }[] = [];
  for (const s of SCRIPT_RANGES) {
    let hits = 0;
    for (const ch of chars) {
      const cp = ch.codePointAt(0)!;
      if (s.ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) hits++;
    }
    if (hits > 0) scriptScores.push({ code: s.code, share: hits / letterCount, confidence: s.confidence });
  }
  scriptScores.sort((a, b) => b.share - a.share);
  const strongScript = scriptScores[0];
  if (strongScript && strongScript.share >= 0.15) {
    const isAmbiguousHan = strongScript.code === 'zh';
    return {
      text: trimmed,
      code: strongScript.code,
      name: LANGUAGE_NAMES[strongScript.code] ?? strongScript.code,
      confidence: isAmbiguousHan ? 'low' : strongScript.share >= 0.4 ? strongScript.confidence : 'medium',
      method: 'script',
      alternatives: scriptScores.slice(1, 3).map((s) => ({ code: s.code, name: LANGUAGE_NAMES[s.code] ?? s.code, score: Number(s.share.toFixed(2)) })),
      note: isAmbiguousHan
        ? 'Han script detected (Chinese/Japanese share it); reported as Chinese with low confidence - confirm before relying on it.'
        : `Detected by Unicode script range analysis (${Math.round(strongScript.share * 100)}% of letters).`
    };
  }

  // 2) Latin-script stopword scoring.
  const words = cleaned.toLowerCase().replace(/[^a-zà-öø-ÿā-žă-ş0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const scored = Object.entries(STOPWORDS)
    .map(([code, list]) => {
      const set = new Set(list);
      const hits = words.filter((w) => set.has(w)).length;
      return { code, name: LANGUAGE_NAMES[code] ?? code, score: words.length > 0 ? hits / Math.max(4, words.length) : 0, hits };
    })
    .sort((a, b) => b.score - a.score || b.hits - a.hits);
  const best = scored[0];
  const second = scored[1];
  if (!best || best.hits === 0) {
    return {
      text: trimmed,
      code: null,
      name: null,
      confidence: 'unknown',
      method: 'stopwords',
      alternatives: [],
      note: 'No language-specific function words matched; the language is honestly unknown.'
    };
  }
  const separation = best.score - (second?.score ?? 0);
  const confidence: LanguageDetection['confidence'] = best.score >= 0.08 && separation >= 0.03 ? 'high' : best.score >= 0.05 ? 'medium' : 'low';
  return {
    text: trimmed,
    code: best.code,
    name: best.name,
    confidence,
    method: 'stopwords',
    alternatives: scored.slice(1, 3).map((s) => ({ code: s.code, name: s.name, score: Number(s.score.toFixed(3)) })),
    note:
      confidence === 'high'
        ? `Detected by function-word frequency (${best.hits} matching words).`
        : confidence === 'medium'
          ? `Detected by function-word frequency with limited separation from ${second?.name ?? 'other candidates'}.`
          : 'Weak function-word signal; treat the language as a low-confidence guess.'
  };
}

// ---- service ------------------------------------------------------------------

const PURPOSE_PROMPTS: Record<TranslationPurpose, string> = {
  customer_inbound: 'Translate the CUSTOMER support message into the target language for an agent to review.',
  agent_draft: 'Translate the AGENT draft reply into the target language the customer asked to be served in.',
  general: 'Translate the text into the target language.'
};

export class TranslationService {
  constructor(
    private db: DB,
    private chat: TranslateChatFn | null
  ) {}

  detect(texts: string[]): LanguageDetection[] {
    return texts.slice(0, 50).map((t) => detectLanguage(typeof t === 'string' ? t : ''));
  }

  /** Detect the languages of a conversation's customer messages + aggregate. */
  conversationLanguages(conversationId: number): ConversationLanguageSummary | null {
    const conv = this.db.prepare('SELECT id FROM conversations WHERE id = ? AND deleted_at IS NULL').get(conversationId) as { id: number } | undefined;
    if (!conv) return null;
    const threads = (this.db
      .prepare("SELECT id, body_html, body_text FROM threads WHERE conversation_id = ? AND type = 'customer' AND deleted_at IS NULL AND state = 'published' ORDER BY remote_created_at ASC LIMIT 100")
      .all(conversationId) as { id: number; body_html: string | null; body_text: string | null }[]);
    const perMessage = threads.map((t) => ({ thread_id: t.id, detection: detectLanguage(htmlToText(t.body_html ?? t.body_text ?? '')) }));
    const counts = new Map<string, number>();
    for (const m of perMessage) {
      if (m.detection.code != null && m.detection.confidence !== 'unknown') counts.set(m.detection.code, (counts.get(m.detection.code) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const primary = ranked[0];
    const primaryDetection = perMessage.find((m) => m.detection.code === primary?.[0])?.detection ?? null;
    const notes: string[] = ['Detection is deterministic (script ranges + function words) and runs entirely locally.'];
    if (primary == null) notes.push('No customer message had a detectable language.');
    if (perMessage.length > 0 && ranked.length > 1) notes.push(`Multiple languages detected (${ranked.map(([c, n]) => `${LANGUAGE_NAMES[c] ?? c} x${n}`).join(', ')}); the primary is the most frequent.`);
    return {
      conversation_id: conversationId,
      customer_messages: perMessage.length,
      analyzed_messages: perMessage.length,
      primary_language: {
        code: primary?.[0] ?? null,
        name: primary ? LANGUAGE_NAMES[primary[0]] ?? primary[0] : null,
        confidence: primaryDetection?.confidence ?? 'unknown',
        method: primaryDetection?.method ?? 'empty'
      },
      per_message: perMessage.map((m) => ({ thread_id: m.thread_id, detection: m.detection })),
      notes
    };
  }

  /** Translate one text (LM Studio only, cached, never sent anywhere). */
  async translate(input: { text: string; from?: string | null; to: string; purpose?: TranslationPurpose }): Promise<TranslationResult> {
    const text = (input.text ?? '').trim();
    const purpose: TranslationPurpose = input.purpose ?? 'general';
    const target = SUPPORTED_LANGUAGES.find((l) => l.code === input.to);
    if (!target) throw new Error(`Unsupported target language '${String(input.to)}'. Supported: ${SUPPORTED_LANGUAGES.map((l) => l.code).join(', ')}.`);
    if (text.length === 0) throw new Error('Nothing to translate: empty text.');
    if (text.length > 8000) throw new Error('Text too long for a single local translation (8000 char cap).');
    if (this.chat == null) {
      throw new Error('Translation is unavailable: AI is disabled in Settings (or LM Studio is not configured). No cloud translation is ever used.');
    }

    // Deterministic detection when 'from' is omitted or 'auto'.
    let detected: LanguageDetection | null = null;
    let sourceLang = (input.from ?? '').trim().toLowerCase();
    if (!sourceLang || sourceLang === 'auto') {
      detected = detectLanguage(text);
      sourceLang = detected.code ?? 'en';
      if (detected.code == null) {
        // Honest: we cannot detect - refuse rather than guess a source.
        throw new Error('Source language could not be detected; please specify it explicitly.');
      }
    }
    if (sourceLang === target.code) {
      throw new Error(`Source and target language are both '${target.code}' - nothing to translate.`);
    }

    const cacheKey = createHash('sha256').update(`${sourceLang}|${target.code}|${purpose}|${text}`).digest('hex');
    const cached = this.db.prepare('SELECT * FROM translation_cache WHERE cache_key = ?').get(cacheKey) as
      | { source_lang: string; target_lang: string; translated_text: string; model: string | null; purpose: string }
      | undefined;
    if (cached) {
      return {
        source_lang: cached.source_lang,
        source_lang_name: LANGUAGE_NAMES[cached.source_lang] ?? cached.source_lang,
        target_lang: cached.target_lang,
        target_lang_name: LANGUAGE_NAMES[cached.target_lang] ?? cached.target_lang,
        purpose: cached.purpose as TranslationPurpose,
        source_text: text,
        translated_text: cached.translated_text,
        model: cached.model,
        cached: true,
        detected,
        note: 'Served from the local translation cache - the model was not re-run. Review original and translation side by side; nothing is sent automatically.'
      };
    }

    const system = [
      `You are a precise translation engine. ${PURPOSE_PROMPTS[purpose]}`,
      `Translate from ${LANGUAGE_NAMES[sourceLang] ?? sourceLang} to ${target.name}.`,
      'Rules:',
      '- Preserve technical terms, product names, feature names, error messages, code, URLs and email addresses VERBATIM (do not translate them).',
      '- Keep the original meaning and tone; do not add, remove or answer any content.',
      '- Keep line breaks and list structure.',
      '- Output ONLY the translated text, no explanations, no quotes.'
    ].join('\n');
    const result = await this.chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: text }], temperature: 0.1, maxTokens: 2048 });
    const translated = (result.content ?? '').trim();
    if (!translated) throw new Error('The local model returned an empty translation.');

    this.db
      .prepare(
        `INSERT INTO translation_cache (cache_key, source_lang, target_lang, purpose, source_text, translated_text, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (cache_key) DO UPDATE SET translated_text = excluded.translated_text, model = excluded.model`
      )
      .run(cacheKey, sourceLang, target.code, purpose, text, translated, result.model ?? null);

    return {
      source_lang: sourceLang,
      source_lang_name: LANGUAGE_NAMES[sourceLang] ?? sourceLang,
      target_lang: target.code,
      target_lang_name: target.name,
      purpose,
      source_text: text,
      translated_text: translated,
      model: result.model ?? null,
      cached: false,
      detected,
      note: 'Translated by the locally configured model (LM Studio) - no cloud service. Review original and translation side by side; nothing is sent automatically.'
    };
  }

  /** Agent's preferred drafting language (settings key, default 'en'). */
  agentLanguage(): { code: string; name: string } {
    const row = this.db.prepare("SELECT value FROM application_settings WHERE key = 'agent_language'").get() as { value: string } | undefined;
    let code = 'en';
    if (row?.value) {
      try {
        const v = JSON.parse(row.value) as unknown;
        if (typeof v === 'string' && SUPPORTED_LANGUAGES.some((l) => l.code === v)) code = v;
      } catch {
        // malformed setting falls back to 'en'
      }
    }
    return { code, name: LANGUAGE_NAMES[code] ?? code };
  }
}
