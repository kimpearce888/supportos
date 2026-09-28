/**
 * M5 shared contract (v2.1.0): local translation (plan Phase 30).
 *
 * Design decisions:
 * - Detection is DETERMINISTIC (script ranges + stopword frequencies) and
 *   honestly reports its method and confidence. 'unknown' is a legitimate
 *   answer; a low-confidence guess is never presented as fact.
 * - Translation runs ONLY on the local LM Studio endpoint (no cloud service,
 *   plan Phase 30 requirement). Results are cached by content hash so the
 *   same text is never re-billed to the model.
 * - Translation NEVER sends anything: translated drafts return to the agent
 *   for side-by-side review, and sending still goes through the existing
 *   human-reviewed write path. Translating is a read of local text plus a
 *   call to the locally configured model.
 * - Technical terms, product names, code, URLs and email addresses are
 *   preserved verbatim via the system prompt - and the UI shows original
 *   next to translated so a human can verify.
 */

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ru', name: 'Russian' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'th', name: 'Thai' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'sv', name: 'Swedish' }
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

export const LANGUAGE_NAMES: Record<string, string> = Object.fromEntries(SUPPORTED_LANGUAGES.map((l) => [l.code, l.name]));

export type DetectionMethod = 'script' | 'stopwords' | 'mixed' | 'empty';

export interface LanguageDetection {
  text: string;
  code: string | null;
  name: string | null;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  method: DetectionMethod;
  /** Runner-up candidates with scores, when the method produced them. */
  alternatives: { code: string; name: string; score: number }[];
  note: string;
}

export type TranslationPurpose = 'customer_inbound' | 'agent_draft' | 'general';

export interface TranslationResult {
  source_lang: string;
  source_lang_name: string | null;
  target_lang: string;
  target_lang_name: string | null;
  purpose: TranslationPurpose;
  source_text: string;
  translated_text: string;
  model: string | null;
  cached: boolean;
  detected: LanguageDetection | null;
  note: string;
}

export interface ConversationLanguageSummary {
  conversation_id: number;
  customer_messages: number;
  analyzed_messages: number;
  primary_language: { code: string | null; name: string | null; confidence: string; method: DetectionMethod };
  per_message: { thread_id: number; detection: LanguageDetection }[];
  notes: string[];
}
