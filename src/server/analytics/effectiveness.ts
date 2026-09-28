import type { DB } from '../database/connection.js';
import { htmlToText } from '../../shared/utils.js';
import type { EffectivenessBucket, EffectivenessReport } from '../../shared/quality.js';

/**
 * Historical response effectiveness (v2.1.0, plan Phase 28).
 *
 * Extends the v1.1 interaction-outcomes layer into an OBSERVATIONAL report
 * of response-style -> outcome relationships. The plan's own requirement:
 * "Do not claim causation from simple correlation." Everything here is
 * stated as association with sample sizes; small buckets say so; the
 * honesty notes are part of the data, not UI garnish.
 *
 * Styles come from the deterministic classifier the interaction engine
 * already stores (detailed_explanation / step_by_step / short_answer /
 * direct_answer_with_explanation). Two independent characteristics are
 * reported separately (documentation_link, technical_explanation) because
 * they are NOT mutually exclusive styles - the report says so.
 */

const STYLE_LABELS: Record<string, string> = {
  detailed_explanation: 'Detailed explanation',
  step_by_step: 'Numbered steps',
  short_answer: 'Concise answer',
  direct_answer_with_explanation: 'Direct answer with explanation'
};

const DOC_LINK_RE = /https?:\/\/|docs?\.[a-z]|\/help\/|knowledge|documentation|\barticle\b|\bguide\b/i;
const TECHNICAL_RE = /\b(api|endpoint|json|sdk|webhook|token|oauth|curl|console|stack trace|log(s)?|http|ssl|css|html|sql|cache)\b/i;

export class ResponseEffectivenessService {
  constructor(private db: DB) {}

  report(days = 90): EffectivenessReport {
    const clamped = Math.max(1, Math.min(3650, days));
    // Outcomes joined to their conversations (bounded to the window) and
    // the reply threads of each conversation for the characteristics pass.
    const outcomes = (this.db
      .prepare(
        `SELECT o.conversation_id, o.response_style, o.follow_up_count, o.clarification_count,
                o.resolved_after_first_response, o.effort_score, o.friction, c.number, c.subject, c.status
         FROM client_support_outcomes o JOIN conversations c ON c.id = o.conversation_id
         WHERE c.deleted_at IS NULL AND o.response_style IS NOT NULL
           AND COALESCE(julianday(c.remote_created_at), julianday(c.local_created_at)) >= julianday('now', ?)
         LIMIT 5000`
      )
      .all(`-${clamped} days`) as {
      conversation_id: number; response_style: string; follow_up_count: number; clarification_count: number;
      resolved_after_first_response: number | null; effort_score: number | null; friction: string; number: number; subject: string | null; status: string;
    }[]);

    // Characteristics per conversation (one pass over reply threads).
    const convIds = [...new Set(outcomes.map((o) => o.conversation_id))];
    const characteristics = new Map<number, { docLink: boolean; technical: boolean }>();
    if (convIds.length > 0) {
      const idList = convIds.map(() => '?').join(',');
      const replyRows = (this.db
        .prepare(
          `SELECT t.conversation_id, t.body_html, t.body_text FROM threads t
           WHERE t.conversation_id IN (${idList}) AND t.type = 'reply' AND t.deleted_at IS NULL AND t.state = 'published'`
        )
        .all(...convIds) as { conversation_id: number; body_html: string | null; body_text: string | null }[]);
      for (const r of replyRows) {
        const text = htmlToText(r.body_html ?? r.body_text ?? '');
        const cur = characteristics.get(r.conversation_id) ?? { docLink: false, technical: false };
        if (DOC_LINK_RE.test(text)) cur.docLink = true;
        if (TECHNICAL_RE.test(text)) cur.technical = true;
        characteristics.set(r.conversation_id, cur);
      }
    }

    // Ratings per conversation.
    const ratingsByConv = new Map<number, string[]>();
    if (convIds.length > 0) {
      const idList = convIds.map(() => '?').join(',');
      const ratingRows = (this.db
        .prepare(`SELECT conversation_id, rating FROM ratings WHERE conversation_id IN (${idList})`)
        .all(...convIds) as { conversation_id: number; rating: string }[]);
      for (const r of ratingRows) {
        const list = ratingsByConv.get(r.conversation_id) ?? [];
        list.push(r.rating);
        ratingsByConv.set(r.conversation_id, list);
      }
    }

    const buildBucket = (key: string, label: string, kind: 'response_style' | 'characteristic', matches: typeof outcomes): EffectivenessBucket => {
      const n = matches.length;
      const rate = (num: number): number | null => (n > 0 ? Number((num / n).toFixed(2)) : null);
      const withFollowUps = matches.filter((o) => o.follow_up_count > 0).length;
      const withClarifications = matches.filter((o) => o.clarification_count > 0).length;
      const resolvedFirst = matches.filter((o) => o.resolved_after_first_response === 1).length;
      const highFriction = matches.filter((o) => o.friction === 'high').length;
      const efforts = matches.map((o) => o.effort_score).filter((e): e is number => e != null);
      const ratingDist: { rating: string; count: number }[] | null =
        matches.length > 0
          ? ['great', 'okay', 'not-good'].map((rating) => ({ rating, count: matches.filter((o) => (ratingsByConv.get(o.conversation_id) ?? []).includes(rating)).length }))
          : null;
      const sample = matches
        .slice(0, 5)
        .map((o) => ({
          conversation_local_id: o.conversation_id,
          number: o.number,
          subject: o.subject,
          outcome_summary: `${o.follow_up_count} follow-up(s), ${o.clarification_count} clarification(s)${o.resolved_after_first_response === 1 ? ', resolved after first response' : ''}${o.effort_score != null ? `, effort ${o.effort_score}/10` : ''}${(ratingsByConv.get(o.conversation_id) ?? []).length > 0 ? `, rated ${(ratingsByConv.get(o.conversation_id) ?? [])[0]}` : ''}`
        }));
      return {
        style_key: key,
        style_label: label,
        kind,
        conversations: n,
        follow_up_rate: rate(withFollowUps),
        clarification_rate: rate(withClarifications),
        resolved_after_first_rate: rate(resolvedFirst),
        avg_effort_score: efforts.length > 0 ? Number((efforts.reduce((a, b) => a + b, 0) / efforts.length).toFixed(1)) : null,
        high_friction_rate: rate(highFriction),
        rating_distribution: ratingDist,
        sample_conversations: sample
      };
    };

    // Buckets with zero conversations carry no information - they stay out
    // of the report instead of presenting empty rows as if they were data.
    const buckets: EffectivenessBucket[] = [];
    const styles = [...new Set(outcomes.map((o) => o.response_style))].filter((s) => s != null);
    for (const style of styles) {
      buckets.push(buildBucket(style, STYLE_LABELS[style] ?? style.replace(/_/g, ' '), 'response_style', outcomes.filter((o) => o.response_style === style)));
    }
    // Independent characteristics (NOT mutually exclusive with styles).
    const docLinkMatches = outcomes.filter((o) => characteristics.get(o.conversation_id)?.docLink === true);
    if (docLinkMatches.length > 0) buckets.push(buildBucket('documentation_link', 'Mentions documentation / links docs', 'characteristic', docLinkMatches));
    const technicalMatches = outcomes.filter((o) => characteristics.get(o.conversation_id)?.technical === true);
    if (technicalMatches.length > 0) buckets.push(buildBucket('technical_explanation', 'Contains technical explanation', 'characteristic', technicalMatches));

    const notes = [
      'These are OBSERVED ASSOCIATIONS between how replies were written and what happened next. They do not show causation: agents may choose detailed replies for harder tickets, so outcomes reflect the mix of situations, not the style alone.',
      'Styles come from the deterministic classifier the interaction engine already stores; characteristics (documentation link, technical explanation) are text-shape detections, not mutually exclusive categories.',
      'Small buckets carry little information: treat any row under 5 conversations as anecdotal.'
    ];

    return {
      generated_at: new Date().toISOString(),
      days: clamped,
      total_analyzed: outcomes.length,
      buckets: buckets.sort((a, b) => b.conversations - a.conversations),
      notes
    };
  }
}
