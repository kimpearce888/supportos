import { type ReactNode, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { Spinner } from '../common/ui.js';
import { useUiStore } from '../../state/uiStore.js';
import type { ConversationLanguageSummary, TranslationResult } from '../../../shared/translation.js';
import { SUPPORTED_LANGUAGES } from '../../../shared/translation.js';

/**
 * Translation panel (v2.1.0, plan Phase 30) - per conversation, in the
 * detail view. Deterministic language detection (always available) plus
 * local-model translation with SIDE-BY-SIDE original/translated display.
 * Nothing is ever sent automatically: a translated draft is a suggestion
 * the agent reviews; sending goes through the normal human write path.
 */
export function TranslationPanel({ conversationId }: { conversationId: number }): ReactNode {
  const [open, setOpen] = useState(false);
  const pushToast = useUiStore((s) => s.pushToast);
  const [target, setTarget] = useState('en');
  const [draft, setDraft] = useState('');
  const [translatedDraft, setTranslatedDraft] = useState<TranslationResult | null>(null);
  const [activeMessage, setActiveMessage] = useState<{ text: string; translated: TranslationResult | null } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['translation-conversation', conversationId],
    queryFn: () => api.get<ConversationLanguageSummary>(`/api/translation/conversation/${conversationId}`),
    enabled: open
  });

  const translate = useMutation({
    mutationFn: (input: { text: string; purpose: 'customer_inbound' | 'agent_draft' }) =>
      api.post<TranslationResult>('/api/translation/translate', { text: input.text, from: 'auto', to: target, purpose: input.purpose }),
    onSuccess: (r) => {
      // v2.2.1 audit fix: a slow earlier per-message request could attach ITS
      // result to whichever message is currently active (click A, then quickly
      // B -> A's translation lands on B). Only apply the result if the text
      // being translated still matches the active message.
      if (activeMessage && r.purpose === 'customer_inbound' && r.source_text === activeMessage.text) setActiveMessage({ ...activeMessage, translated: r });
      if (r.purpose === 'agent_draft') setTranslatedDraft(r);
      if (r.cached) pushToast({ kind: 'info', message: 'Served from the local translation cache.' });
    },
    onError: (e: Error) => pushToast({ kind: 'error', message: e.message })
  });

  return (
    <section className="card translation-panel">
      <button className="card-title collapsible" onClick={() => setOpen((v) => !v)}>
        Translation (local model) {open ? '▾' : '▸'}
      </button>
      {open ? (
        <>
          <p className="muted text-xs mb-8">
            Language detection is deterministic and local. Translation uses only the locally configured model (no cloud); technical terms, URLs and emails are preserved. Nothing is sent automatically.
          </p>
          <div className="flex gap-8 align-center mb-12 wrap">
            <label className="flex gap-4 align-center text-sm">
              Translate to
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {SUPPORTED_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </label>
          </div>

          {isLoading ? <Spinner /> : null}

          {data ? (
            <div className="mb-12">
              <div className="text-sm">
                <strong>Customer language:</strong>{' '}
                {data.primary_language.name ?? 'unknown'}
                {data.primary_language.code ? <span className={`badge ml-8 ${data.primary_language.confidence === 'high' ? 'ok' : data.primary_language.confidence === 'low' || data.primary_language.confidence === 'unknown' ? 'warn' : ''}`}>{data.primary_language.confidence} confidence · {data.primary_language.method}</span> : null}
              </div>
              <div className="muted text-xs mt-4">{data.notes.join(' ')}</div>
              {data.per_message.length > 0 ? (
                <div className="flex col gap-4 mt-8">
                  {data.per_message.slice(0, 8).map((m) => (
                    <button
                      key={m.thread_id}
                      className="btn tiny ghost text-left"
                      onClick={() => {
                        const text = (m.detection.text ?? '').slice(0, 800);
                        setActiveMessage({ text, translated: null });
                        if (m.detection.code && m.detection.code !== target) translate.mutate({ text, purpose: 'customer_inbound' });
                      }}
                      title="Translate this message"
                    >
                      #{m.thread_id} · {m.detection.name ?? 'unknown'} ({m.detection.confidence}) · {m.detection.text.slice(0, 60)}…
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {activeMessage ? (
            <div className="translation-side-by-side mb-12">
              <div className="translation-col">
                <div className="muted text-xs mb-4">Original</div>
                <div className="text-sm pre-wrap">{activeMessage.text}</div>
              </div>
              <div className="translation-col">
                <div className="muted text-xs mb-4">Translated {translate.isPending ? <Spinner /> : null}</div>
                <div className="text-sm pre-wrap">{activeMessage.translated ? activeMessage.translated.translated_text : <span className="muted">Press translate below.</span>}</div>
                {activeMessage.translated ? <div className="muted text-xs mt-4">{activeMessage.translated.note}</div> : null}
              </div>
              <div className="flex gap-8 mt-4">
                <button className="btn small" onClick={() => translate.mutate({ text: activeMessage.text, purpose: 'customer_inbound' })} disabled={translate.isPending}>
                  Translate message
                </button>
                <button className="btn small ghost" onClick={() => setActiveMessage(null)}>Close</button>
              </div>
            </div>
          ) : null}

          <div className="agent-draft-translation">
            <div className="muted text-xs mb-4">Draft in your language, translate for the customer (review before using - nothing sends from here):</div>
            <textarea
              className="input"
              rows={3}
              value={draft}
              placeholder="Write your reply draft here, then translate it…"
              onChange={(e) => setDraft(e.target.value)}
              maxLength={4000}
            />
            <div className="flex gap-8 mt-4">
              <button className="btn small" onClick={() => translate.mutate({ text: draft, purpose: 'agent_draft' })} disabled={translate.isPending || draft.trim() === ''}>
                Translate draft
              </button>
              {translatedDraft ? (
                <button className="btn small ghost" onClick={() => { void navigator.clipboard?.writeText(translatedDraft.translated_text); pushToast({ kind: 'success', message: 'Translated draft copied to clipboard.' }); }}>
                  Copy translation
                </button>
              ) : null}
            </div>
            {translatedDraft ? (
              <div className="translation-side-by-side mt-8">
                <div className="translation-col">
                  <div className="muted text-xs mb-4">Your draft ({translatedDraft.source_lang_name ?? 'source'})</div>
                  <div className="text-sm pre-wrap">{translatedDraft.source_text}</div>
                </div>
                <div className="translation-col">
                  <div className="muted text-xs mb-4">{translatedDraft.target_lang_name ?? 'target'} translation</div>
                  <div className="text-sm pre-wrap">{translatedDraft.translated_text}</div>
                  <div className="muted text-xs mt-4">{translatedDraft.note}</div>
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
