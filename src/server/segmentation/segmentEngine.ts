import type { DB } from '../database/connection.js';
import type {
  SegmentDefinition,
  SegmentNode,
  SegmentGroup,
  SegmentMatchRow,
  SegmentPreviewResult,
  WhyLine,
  RecipientWhyTicket,
  CustomerPropertyCondition,
  ContactCondition,
  TicketCondition,
  HistoryCondition,
  HistoryTagCondition
} from '../../shared/segmentation.js';

/**
 * SegmentEngine (v1.5.0): deterministic, contact-first audience evaluation.
 *
 * Architecture (segmentation spec #42/#65): the engine runs against SQLite and
 * produces unique customer ids. It evaluates each condition node as a SET of
 * customer ids (parameterized SQL per node), then combines sets with
 * intersection ('all') / union ('any') and subtracts exclusions. Set-per-node
 * was chosen over compiling the whole tree into one SQL statement deliberately:
 *
 * - correctness: tag ANY/ALL/NONE intersection happens at the CONVERSATION
 *   level inside one node's SQL, which is exactly the spec's core semantic
 *   (critical tests #60-#62) and is easy to unit-test per node;
 * - explainability: per-node evaluation makes "why was I selected?" cheap -
 *   each node contributes its own evidence line, re-checked per customer;
 * - scale: customer counts are support-scale (thousands) and every node query
 *   is index-backed (conversations(customer_local_id,status),
 *   conversation_tags(tag_local_id), customer_properties(definition_id)).
 *
 * AI never participates: the LLM may explain or suggest a segment, but the
 * recipient set is always this deterministic engine's output (spec #43).
 */
export class SegmentEngine {
  constructor(private db: DB) {}

  // ---------------- Entry points ----------------

  /** Evaluate a full segment definition -> preview rows (paged evidence). */
  preview(def: SegmentDefinition, page = 1, pageSize = 50): SegmentPreviewResult {
    const notes: string[] = [];
    const include = this.evaluateNodes(def.conditions, def.combinator === 'all', notes);
    const exclude = new Set<number>();
    if (def.exclude.length > 0) {
      for (const id of this.evaluateNodes(def.exclude, false, notes)) exclude.add(id);
    }
    const dnc = new Set(
      (this.db.prepare('SELECT customer_local_id FROM do_not_contact').all() as { customer_local_id: number }[]).map((r) => r.customer_local_id)
    );

    const matched = include.filter((id) => !exclude.has(id) && !dnc.has(id));
    const rows = matched.length === 0 ? [] : this.buildRows(matched, def, page, pageSize, exclude, dnc);
    const withoutEmail = matched.filter((id) => this.primaryEmail(id) == null).length;
    if (def.exclude.length > 0 && exclude.size > 0) notes.push(`${exclude.size} customer(s) matched exclusion conditions.`);
    const dncRemoved = include.filter((id) => dnc.has(id)).length;
    if (dncRemoved > 0) notes.push(`${dncRemoved} customer(s) removed by the Do-Not-Contact list.`);
    return { matched: matched.length, excluded: exclude.size, without_email: withoutEmail, on_dnc: dnc.size, rows, notes };
  }

  /** Fast count-only evaluation (segment "estimated matches"). */
  count(def: SegmentDefinition): number {
    const include = this.evaluateNodes(def.conditions, def.combinator === 'all', []);
    if (include.length === 0) return 0;
    const exclude = new Set(this.evaluateNodes(def.exclude, false, []));
    const dnc = new Set(
      (this.db.prepare('SELECT customer_local_id FROM do_not_contact').all() as { customer_local_id: number }[]).map((r) => r.customer_local_id)
    );
    return include.filter((id) => !exclude.has(id) && !dnc.has(id)).length;
  }

  // ---------------- Tree evaluation ----------------

  private evaluateNodes(nodes: SegmentNode[], intersect: boolean, notes: string[], depth = 0): number[] {
    if (depth > 16) {
      // Defense in depth: routes already cap trees at depth 10, but the engine
      // is callable from other paths - refuse runaway recursion loudly, never
      // as a stack overflow that takes the process down.
      notes.push('Condition tree rejected: nesting deeper than supported.');
      return [];
    }
    if (nodes.length === 0) {
      // Empty condition list = "everyone" for include trees, "no one" for exclude trees.
      return intersect ? this.allCustomerIds() : [];
    }
    let acc: number[] | null = null;
    for (const node of nodes) {
      const ids = this.evaluateNode(node, notes, depth);
      if (acc == null) {
        acc = ids;
      } else if (intersect) {
        const set = new Set(ids);
        acc = acc.filter((id) => set.has(id));
      } else {
        const set = new Set(acc);
        for (const id of ids) if (!set.has(id)) acc.push(id);
      }
    }
    return acc ?? [];
  }

  private evaluateNode(node: SegmentNode, notes: string[], depth = 0): number[] {
    if (this.isGroup(node)) return this.evaluateNodes(node.children, node.combinator === 'all', notes, depth + 1);
    switch (node.kind) {
      case 'customer_property':
        return this.evalCustomerProperty(node);
      case 'contact':
        return this.evalContact(node);
      case 'ticket':
        return this.evalTicket(node, notes);
      case 'history':
        return this.evalHistory(node);
      case 'history_tag':
        return this.evalHistoryTag(node);
      default:
        return [];
    }
  }

  private isGroup(node: SegmentNode): node is SegmentGroup {
    return (node as SegmentGroup).kind === 'group';
  }

  private allCustomerIds(): number[] {
    return (this.db.prepare('SELECT id FROM customers WHERE deleted_at IS NULL').all() as { id: number }[]).map((r) => r.id);
  }

  // ---------------- Condition implementations ----------------

  /** Customer-property condition over customer_properties (definition id + typed operator). */
  private evalCustomerProperty(c: CustomerPropertyCondition): number[] {
    const val = (c.value ?? '').trim();
    switch (c.op) {
      case 'is_empty':
        return this.ids(`SELECT cp.customer_id AS cid FROM customer_properties cp WHERE cp.definition_id = ? AND (cp.value IS NULL OR cp.value = '')`, [c.definitionId]);
      case 'is_not_empty':
        return this.ids(`SELECT cp.customer_id AS cid FROM customer_properties cp WHERE cp.definition_id = ? AND cp.value IS NOT NULL AND cp.value <> ''`, [c.definitionId]);
      case 'equals':
        return this.ids(`SELECT cp.customer_id AS cid FROM customer_properties cp WHERE cp.definition_id = ? AND LOWER(cp.value) = LOWER(?)`, [c.definitionId, val]);
      case 'not_equals':
        return this.ids(
          `SELECT c.id AS cid FROM customers c WHERE c.deleted_at IS NULL AND c.id NOT IN (SELECT cp.customer_id FROM customer_properties cp WHERE cp.definition_id = ? AND LOWER(cp.value) = LOWER(?))`,
          [c.definitionId, val]
        );
      case 'contains':
        return this.ids(`SELECT cp.customer_id AS cid FROM customer_properties cp WHERE cp.definition_id = ? AND cp.value LIKE ? ESCAPE '\\'`, [c.definitionId, `%${escapeLike(val)}%`]);
      case 'not_contains':
        return this.ids(
          `SELECT c.id AS cid FROM customers c WHERE c.deleted_at IS NULL AND c.id NOT IN (SELECT cp.customer_id FROM customer_properties cp WHERE cp.definition_id = ? AND cp.value LIKE ? ESCAPE '\\')`,
          [c.definitionId, `%${escapeLike(val)}%`]
        );
      case 'starts_with':
        return this.ids(`SELECT cp.customer_id AS cid FROM customer_properties cp WHERE cp.definition_id = ? AND cp.value LIKE ? ESCAPE '\\'`, [c.definitionId, `${escapeLike(val)}%`]);
      case 'ends_with':
        return this.ids(`SELECT cp.customer_id AS cid FROM customer_properties cp WHERE cp.definition_id = ? AND cp.value LIKE ? ESCAPE '\\'`, [c.definitionId, `%${escapeLike(val)}`]);
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const n = Number(val);
        if (!Number.isFinite(n)) return [];
        const opSql = c.op === 'gt' ? '>' : c.op === 'gte' ? '>=' : c.op === 'lt' ? '<' : '<=';
        return this.ids(`SELECT cp.customer_id AS cid FROM customer_properties cp WHERE cp.definition_id = ? AND CAST(cp.value AS REAL) ${opSql} ?`, [c.definitionId, n]);
      }
      case 'between': {
        const a = Number(val);
        const b = Number(c.value2 ?? '');
        if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
        return this.ids(`SELECT cp.customer_id AS cid FROM customer_properties cp WHERE cp.definition_id = ? AND CAST(cp.value AS REAL) BETWEEN ? AND ?`, [c.definitionId, Math.min(a, b), Math.max(a, b)]);
      }
      case 'before':
        if (!val) return [];
        return this.ids(`SELECT cp.customer_id AS cid FROM customer_properties cp WHERE cp.definition_id = ? AND cp.value < ?`, [c.definitionId, val]);
      case 'after':
        if (!val) return [];
        return this.ids(`SELECT cp.customer_id AS cid FROM customer_properties cp WHERE cp.definition_id = ? AND cp.value > ?`, [c.definitionId, val]);
      case 'is_any_of': {
        const list = (c.values ?? []).map((s) => s.toLowerCase()).filter(Boolean);
        if (list.length === 0) return [];
        return this.ids(`SELECT cp.customer_id AS cid FROM customer_properties cp WHERE cp.definition_id = ? AND LOWER(cp.value) IN (${list.map(() => '?').join(',')})`, [c.definitionId, ...list]);
      }
      case 'is_none_of': {
        const list = (c.values ?? []).map((s) => s.toLowerCase()).filter(Boolean);
        if (list.length === 0) return this.allCustomerIds();
        return this.ids(
          `SELECT c.id AS cid FROM customers c WHERE c.deleted_at IS NULL AND c.id NOT IN (SELECT cp.customer_id FROM customer_properties cp WHERE cp.definition_id = ? AND LOWER(cp.value) IN (${list.map(() => '?').join(',')}))`,
          [c.definitionId, ...list]
        );
      }
      default:
        return [];
    }
  }

  /** Contact-field condition over the synced customer record (contact-first supplement). */
  private evalContact(c: ContactCondition): number[] {
    const val = (c.value ?? '').trim();
    switch (c.field) {
      case 'has_email':
      case 'has_phone': {
        const table = c.field === 'has_email' ? 'customer_emails' : 'customer_phones';
        const isEmpty = c.op === 'is_empty';
        const sql = isEmpty
          ? `SELECT c.id AS cid FROM customers c WHERE c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.customer_id = c.id)`
          : `SELECT DISTINCT x.customer_id AS cid FROM ${table} x JOIN customers c ON c.id = x.customer_id WHERE c.deleted_at IS NULL`;
        return this.ids(sql, []);
      }
      case 'has_multiple_emails':
        return this.ids(
          `SELECT ce.customer_id AS cid FROM customer_emails ce JOIN customers c ON c.id = ce.customer_id WHERE c.deleted_at IS NULL GROUP BY ce.customer_id HAVING COUNT(*) > 1`,
          []
        );
      case 'email': {
        if (c.op === 'is_empty' || c.op === 'is_not_empty') {
          const isEmpty = c.op === 'is_empty';
          const sql = isEmpty
            ? `SELECT c.id AS cid FROM customers c WHERE c.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM customer_emails ce WHERE ce.customer_id = c.id)`
            : `SELECT DISTINCT ce.customer_id AS cid FROM customer_emails ce JOIN customers c ON c.id = ce.customer_id WHERE c.deleted_at IS NULL`;
          return this.ids(sql, []);
        }
        if (!val) return [];
        switch (c.op) {
          case 'equals':
            return this.ids(`SELECT DISTINCT ce.customer_id AS cid FROM customer_emails ce JOIN customers c ON c.id = ce.customer_id WHERE c.deleted_at IS NULL AND LOWER(ce.value) = LOWER(?)`, [val]);
          case 'not_equals':
            return this.ids(`SELECT c.id AS cid FROM customers c WHERE c.deleted_at IS NULL AND c.id NOT IN (SELECT ce.customer_id FROM customer_emails ce WHERE LOWER(ce.value) = LOWER(?))`, [val]);
          case 'contains':
            return this.ids(`SELECT DISTINCT ce.customer_id AS cid FROM customer_emails ce JOIN customers c ON c.id = ce.customer_id WHERE c.deleted_at IS NULL AND ce.value LIKE ? ESCAPE '\\'`, [`%${escapeLike(val)}%`]);
          case 'starts_with':
            return this.ids(`SELECT DISTINCT ce.customer_id AS cid FROM customer_emails ce JOIN customers c ON c.id = ce.customer_id WHERE c.deleted_at IS NULL AND ce.value LIKE ? ESCAPE '\\'`, [`${escapeLike(val)}%`]);
          case 'ends_with':
            return this.ids(`SELECT DISTINCT ce.customer_id AS cid FROM customer_emails ce JOIN customers c ON c.id = ce.customer_id WHERE c.deleted_at IS NULL AND ce.value LIKE ? ESCAPE '\\'`, [`%${escapeLike(val)}`]);
          default:
            return [];
        }
      }
      case 'email_domain': {
        const domain = val.replace(/^@/, '').toLowerCase();
        if (!domain) return [];
        return this.ids(
          `SELECT DISTINCT ce.customer_id AS cid FROM customer_emails ce JOIN customers c ON c.id = ce.customer_id WHERE c.deleted_at IS NULL AND LOWER(ce.value) LIKE ? ESCAPE '\\'`,
          [`%@${escapeLike(domain)}%`]
        );
      }
      default: {
        const col: Record<string, string> = {
          name: `(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))`,
          organization: `o.name`,
          job_title: `c.job_title`,
          location: `c.location`,
          background: `c.background`
        };
        const expr = col[c.field];
        if (!expr) return [];
        const from = `FROM customers c LEFT JOIN organizations o ON o.id = c.organization_id`;
        switch (c.op) {
          case 'is_empty':
            return this.ids(`SELECT c.id AS cid ${from} WHERE c.deleted_at IS NULL AND (${expr} IS NULL OR TRIM(${expr}) = '')`, []);
          case 'is_not_empty':
            return this.ids(`SELECT c.id AS cid ${from} WHERE c.deleted_at IS NULL AND (${expr} IS NOT NULL AND TRIM(${expr}) <> '')`, []);
          case 'equals':
            if (!val) return [];
            return this.ids(`SELECT c.id AS cid ${from} WHERE c.deleted_at IS NULL AND LOWER(${expr}) = LOWER(?)`, [val]);
          case 'not_equals':
            if (!val) return [];
            return this.ids(`SELECT c.id AS cid ${from} WHERE c.deleted_at IS NULL AND (LOWER(${expr}) <> LOWER(?) OR ${expr} IS NULL)`, [val]);
          case 'contains':
            if (!val) return [];
            return this.ids(`SELECT c.id AS cid ${from} WHERE c.deleted_at IS NULL AND ${expr} LIKE ? ESCAPE '\\'`, [`%${escapeLike(val)}%`]);
          case 'starts_with':
            if (!val) return [];
            return this.ids(`SELECT c.id AS cid ${from} WHERE c.deleted_at IS NULL AND ${expr} LIKE ? ESCAPE '\\'`, [`${escapeLike(val)}%`]);
          case 'ends_with':
            if (!val) return [];
            return this.ids(`SELECT c.id AS cid ${from} WHERE c.deleted_at IS NULL AND ${expr} LIKE ? ESCAPE '\\'`, [`%${escapeLike(val)}`]);
          default:
            return [];
        }
      }
    }
  }

  /**
   * Ticket condition: ALL filters inside ONE node apply to the SAME
   * conversation; tags ANY/ALL/NONE resolve at the conversation level BEFORE
   * mapping to customers (spec #5-#7, critical tests #60-#62).
   */
  private evalTicket(t: TicketCondition, notes: string[]): number[] {
    const where: string[] = ['c.deleted_at IS NULL', 'c.customer_local_id IS NOT NULL'];
    const params: unknown[] = [];

    const statuses = (t.statuses ?? []).filter(Boolean);
    if (statuses.length > 0) {
      where.push(`c.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const mailboxes = (t.mailboxLocalIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
    if (mailboxes.length > 0) {
      where.push(`c.mailbox_local_id IN (${mailboxes.map(() => '?').join(',')})`);
      params.push(...mailboxes);
    }
    const assignees = (t.assigneeLocalIds ?? []).filter((n) => Number.isInteger(n));
    if (assignees.length > 0) {
      const unassigned = assignees.includes(-1);
      const listed = assignees.filter((a) => a !== -1);
      if (unassigned && listed.length > 0) {
        where.push(`(c.assignee_local_id IS NULL OR c.assignee_local_id IN (${listed.map(() => '?').join(',')}))`);
        params.push(...listed);
      } else if (unassigned) {
        where.push(`c.assignee_local_id IS NULL`);
      } else {
        where.push(`c.assignee_local_id IN (${listed.map(() => '?').join(',')})`);
        params.push(...listed);
      }
    }
    if (t.createdWithinDays != null && Number.isFinite(t.createdWithinDays)) {
      where.push(`c.remote_created_at >= datetime('now', ?)`);
      params.push(`-${Math.max(0, t.createdWithinDays)} days`);
    }
    if (t.modifiedWithinDays != null && Number.isFinite(t.modifiedWithinDays)) {
      where.push(`COALESCE(c.remote_updated_at, c.remote_created_at) >= datetime('now', ?)`);
      params.push(`-${Math.max(0, t.modifiedWithinDays)} days`);
    }
    if (t.numberMin != null && Number.isFinite(t.numberMin)) {
      where.push(`c.number >= ?`);
      params.push(t.numberMin);
    }
    if (t.numberMax != null && Number.isFinite(t.numberMax)) {
      where.push(`c.number <= ?`);
      params.push(t.numberMax);
    }

    const tags = (t.tags ?? []).map((s) => s.trim()).filter(Boolean);
    const tagMode = t.tagMode ?? 'any';
    if (tags.length > 0) {
      const tagParams = tags.map(() => '?').join(',');
      if (tagMode === 'all') {
        // The SAME conversation must carry every tag (spec #18, critical test #60).
        // Scalar COUNT comparison instead of EXISTS+HAVING: SQLite rejects
        // HAVING on a non-aggregate select, and the correlated subquery reads
        // cleanly as "count this conversation's matching distinct tags".
        where.push(
          `(SELECT COUNT(DISTINCT LOWER(tg.name)) FROM conversation_tags ct JOIN tags tg ON tg.id = ct.tag_local_id WHERE ct.conversation_id = c.id AND LOWER(tg.name) IN (${tagParams})) = ${tags.length}`
        );
        params.push(...tags.map((s) => s.toLowerCase()));
        if (tags.length > 1) notes.push(`Tag mode ALL requires one single conversation carrying all ${tags.length} tags (conversation-level intersection).`);
      } else if (tagMode === 'none') {
        // The qualifying conversation must NOT carry any of these tags.
        where.push(`NOT EXISTS (SELECT 1 FROM conversation_tags ct JOIN tags tg ON tg.id = ct.tag_local_id WHERE ct.conversation_id = c.id AND LOWER(tg.name) IN (${tagParams}))`);
        params.push(...tags.map((s) => s.toLowerCase()));
      } else {
        where.push(`EXISTS (SELECT 1 FROM conversation_tags ct JOIN tags tg ON tg.id = ct.tag_local_id WHERE ct.conversation_id = c.id AND LOWER(tg.name) IN (${tagParams}))`);
        params.push(...tags.map((s) => s.toLowerCase()));
      }
    }

    const sql = `SELECT DISTINCT c.customer_local_id AS cid FROM conversations c WHERE ${where.join(' AND ')}`;
    return this.ids(sql, params);
  }

  /** Support-history conditions computed from the local mirror (spec #13). */
  private evalHistory(h: HistoryCondition): number[] {
    const v = Number(h.value);
    if (!Number.isFinite(v)) return [];
    // Count metrics are computed as CORRELATED subqueries over ALL customers,
    // not GROUP BY over existing rows: "open tickets = 0" must select customers
    // with NO matching row at all (GROUP BY would silently exclude them).
    const cmp = h.op === 'gte' ? '>= ?' : h.op === 'lte' ? '<= ?' : '= ?';
    const countCond = (statusFilter: string): string =>
      `(SELECT COUNT(*) FROM conversations cv WHERE cv.customer_local_id = c.id AND cv.deleted_at IS NULL${statusFilter}) ${cmp}`;
    switch (h.metric) {
      case 'ticket_count':
        return this.ids(`SELECT c.id AS cid FROM customers c WHERE c.deleted_at IS NULL AND ${countCond('')}`, [v]);
      case 'open_count':
        return this.ids(`SELECT c.id AS cid FROM customers c WHERE c.deleted_at IS NULL AND ${countCond(" AND cv.status = 'active'")}`, [v]);
      case 'closed_count':
        return this.ids(`SELECT c.id AS cid FROM customers c WHERE c.deleted_at IS NULL AND ${countCond(" AND cv.status = 'closed'")}`, [v]);
      case 'last_contact_within_days':
        return this.ids(
          `SELECT DISTINCT c.customer_local_id AS cid FROM conversations c JOIN customers cu ON cu.id = c.customer_local_id WHERE c.deleted_at IS NULL AND cu.deleted_at IS NULL AND COALESCE(c.last_activity_at, c.remote_created_at) >= datetime('now', ?)`,
          [`-${Math.max(0, v)} days`]
        );
      case 'first_contact_before_days':
        return this.ids(
          `SELECT DISTINCT c.customer_local_id AS cid FROM conversations c JOIN customers cu ON cu.id = c.customer_local_id WHERE c.deleted_at IS NULL AND cu.deleted_at IS NULL AND c.remote_created_at < datetime('now', ?)`,
          [`-${Math.max(0, v)} days`]
        );
      default:
        return [];
    }
  }

  private evalHistoryTag(h: HistoryTagCondition): number[] {
    const tag = (h.tag ?? '').trim().toLowerCase();
    if (!tag) return [];
    if (h.withinDays != null && Number.isFinite(h.withinDays)) {
      return this.ids(
        `SELECT DISTINCT c.customer_local_id AS cid FROM conversations c
           JOIN conversation_tags ct ON ct.conversation_id = c.id JOIN tags tg ON tg.id = ct.tag_local_id
           JOIN customers cu ON cu.id = c.customer_local_id
         WHERE c.deleted_at IS NULL AND cu.deleted_at IS NULL AND LOWER(tg.name) = ? AND c.remote_created_at >= datetime('now', ?)`,
        [tag, `-${Math.max(0, h.withinDays)} days`]
      );
    }
    return this.ids(
      `SELECT DISTINCT c.customer_local_id AS cid FROM conversations c
         JOIN conversation_tags ct ON ct.conversation_id = c.id JOIN tags tg ON tg.id = ct.tag_local_id
         JOIN customers cu ON cu.id = c.customer_local_id
       WHERE c.deleted_at IS NULL AND cu.deleted_at IS NULL AND LOWER(tg.name) = ?`,
      [tag]
    );
  }

  // ---------------- Row building (explainability) ----------------

  private buildRows(matched: number[], def: SegmentDefinition, page: number, pageSize: number, exclude: Set<number>, dnc: Set<number>): SegmentMatchRow[] {
    const slice = matched.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
    const propertyDefs = this.db.prepare('SELECT id, name FROM customer_property_definitions').all() as { id: number; name: string }[];
    const defById = new Map(propertyDefs.map((d) => [d.id, d.name]));
    return slice.map((cid) => {
      const cust = this.db
        .prepare(
          `SELECT c.id, c.remote_id, c.first_name, c.last_name, c.job_title,
             o.name AS organization,
             (SELECT COUNT(*) FROM conversations cv WHERE cv.customer_local_id = c.id AND cv.deleted_at IS NULL) AS total_tickets,
             (SELECT COUNT(*) FROM conversations cv WHERE cv.customer_local_id = c.id AND cv.status = 'active' AND cv.deleted_at IS NULL) AS open_tickets,
             (SELECT MAX(COALESCE(cv.last_activity_at, cv.remote_created_at)) FROM conversations cv WHERE cv.customer_local_id = c.id AND cv.deleted_at IS NULL) AS last_contact
           FROM customers c LEFT JOIN organizations o ON o.id = c.organization_id WHERE c.id = ?`
        )
        .get(cid) as
        | {
            id: number;
            remote_id: number;
            first_name: string | null;
            last_name: string | null;
            job_title: string | null;
            organization: string | null;
            total_tickets: number;
            open_tickets: number;
            last_contact: string | null;
          }
        | undefined;
      const emails = (this.db.prepare('SELECT value FROM customer_emails WHERE customer_id = ? AND value IS NOT NULL ORDER BY id').all(cid) as { value: string }[]).map((r) => r.value);
      const properties = (this.db.prepare('SELECT cp.definition_id, cp.value FROM customer_properties cp WHERE cp.customer_id = ?').all(cid) as { definition_id: number; value: string | null }[])
        .map((p) => ({ name: defById.get(p.definition_id) ?? `property #${p.definition_id}`, value: p.value }))
        .filter((p) => p.value != null && p.value !== '');
      const why = this.explainFor(cid, def);
      const matchingTickets = this.collectMatchingTickets(cid, def);
      const excluded = exclude.has(cid) || dnc.has(cid);
      if (!cust) {
        return {
          customer_local_id: cid,
          customer_remote_id: 0,
          first_name: null,
          last_name: null,
          emails,
          chosen_email: this.primaryEmail(cid),
          organization: null,
          job_title: null,
          properties,
          open_tickets: 0,
          total_tickets: 0,
          last_contact: null,
          why,
          matching_tickets: matchingTickets,
          excluded,
          exclusion_reason: excluded ? 'matched an exclusion condition' : null
        };
      }
      return {
        customer_local_id: cid,
        customer_remote_id: cust.remote_id,
        first_name: cust.first_name,
        last_name: cust.last_name,
        emails,
        chosen_email: this.primaryEmail(cid),
        organization: cust.organization,
        job_title: cust.job_title,
        properties,
        open_tickets: cust.open_tickets,
        total_tickets: cust.total_tickets,
        last_contact: cust.last_contact,
        why,
        matching_tickets: matchingTickets,
        excluded,
        exclusion_reason: excluded ? 'matched an exclusion condition' : null
      };
    });
  }

  /** Re-check each include condition for ONE customer -> "why selected" lines (spec #10/#38). */
  private explainFor(cid: number, def: SegmentDefinition): WhyLine[] {
    const out: WhyLine[] = [];
    const walk = (nodes: SegmentNode[]): void => {
      for (const n of nodes) {
        if (this.isGroup(n)) {
          walk(n.children);
          continue;
        }
        if (n.kind === 'customer_property') {
          const row = this.db.prepare('SELECT cp.value FROM customer_properties cp WHERE cp.customer_id = ? AND cp.definition_id = ?').get(cid, n.definitionId) as { value: string | null } | undefined;
          const has = row != null && row.value != null && row.value !== '';
          if (!has) continue;
          if (n.op === 'is_empty') continue; // matched by absence; nothing to quote
          if (n.op === 'is_any_of' || n.op === 'is_none_of') {
            out.push({ text: `${n.name}: "${row.value}" ${n.op === 'is_any_of' ? 'is one of' : 'is none of'} ${(n.values ?? []).join(', ')}` });
          } else {
            out.push({ text: `${n.name} = ${row.value}` });
          }
        } else if (n.kind === 'contact') {
          if (n.field === 'email_domain') {
            const email = this.primaryEmail(cid);
            if (email) out.push({ text: `email domain: ${email.split('@')[1] ?? ''}` });
          } else if (n.field === 'email') {
            const email = this.primaryEmail(cid);
            if (email) out.push({ text: `email ${describeOp(n.op)} ${n.value ?? email}` });
          } else if (n.field === 'organization') {
            const org = (this.db.prepare('SELECT o.name FROM customers c LEFT JOIN organizations o ON o.id = c.organization_id WHERE c.id = ?').get(cid) as { name: string | null } | undefined)?.name;
            if (org) out.push({ text: `organization ${describeOp(n.op)} ${n.value ?? org}` });
          } else if (n.field === 'has_email' || n.field === 'has_phone' || n.field === 'has_multiple_emails') {
            out.push({ text: describeContactPresence(n.field) });
          } else {
            const col: Record<string, string> = { name: 'name', job_title: 'job title', location: 'location', background: 'background' };
            out.push({ text: `${col[n.field] ?? n.field} ${describeOp(n.op)} ${n.value ?? ''}` });
          }
        } else if (n.kind === 'ticket') {
          const tickets = this.ticketsForCustomerMatching(cid, n);
          if (tickets.length > 0) {
            const bits: string[] = [];
            if (n.tags?.length) bits.push(`has ${n.tagMode === 'all' ? 'ALL of' : n.tagMode === 'none' ? 'NONE of' : 'ANY of'}: ${n.tags.join(', ')}`);
            if (n.statuses?.length) bits.push(`status: ${n.statuses.join('/')}`);
            if (n.mailboxLocalIds?.length) bits.push('inbox filtered');
            if (n.createdWithinDays != null) bits.push(`created within ${n.createdWithinDays} days`);
            if (n.modifiedWithinDays != null) bits.push(`modified within ${n.modifiedWithinDays} days`);
            out.push({ text: `Ticket ${bits.join(' + ') || 'match'}`, tickets });
          } else {
            out.push({ text: 'Ticket condition satisfied' });
          }
        } else if (n.kind === 'history') {
          out.push({ text: describeHistory(n) });
        } else if (n.kind === 'history_tag') {
          out.push({ text: `has a ticket tagged "${n.tag}"${n.withinDays != null ? ` within ${n.withinDays} days` : ''}` });
        }
      }
    };
    walk(def.conditions);
    return out;
  }

  /** Conversations of one customer satisfying a ticket node (evidence). */
  private ticketsForCustomerMatching(cid: number, t: TicketCondition): RecipientWhyTicket[] {
    const where: string[] = ['c.deleted_at IS NULL', 'c.customer_local_id = ?'];
    const params: unknown[] = [cid];
    const statuses = (t.statuses ?? []).filter(Boolean);
    if (statuses.length > 0) {
      where.push(`c.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (t.createdWithinDays != null && Number.isFinite(t.createdWithinDays)) {
      where.push(`c.remote_created_at >= datetime('now', ?)`);
      params.push(`-${Math.max(0, t.createdWithinDays)} days`);
    }
    if (t.modifiedWithinDays != null && Number.isFinite(t.modifiedWithinDays)) {
      where.push(`COALESCE(c.remote_updated_at, c.remote_created_at) >= datetime('now', ?)`);
      params.push(`-${Math.max(0, t.modifiedWithinDays)} days`);
    }
    const tags = (t.tags ?? []).map((s) => s.trim()).filter(Boolean);
    const tagMode = t.tagMode ?? 'any';
    if (tags.length > 0) {
      const tagParams = tags.map(() => '?').join(',');
      if (tagMode === 'all') {
        where.push(`(SELECT COUNT(DISTINCT LOWER(tg.name)) FROM conversation_tags ct JOIN tags tg ON tg.id = ct.tag_local_id WHERE ct.conversation_id = c.id AND LOWER(tg.name) IN (${tagParams})) = ${tags.length}`);
        params.push(...tags.map((s) => s.toLowerCase()));
      } else if (tagMode === 'none') {
        where.push(`NOT EXISTS (SELECT 1 FROM conversation_tags ct JOIN tags tg ON tg.id = ct.tag_local_id WHERE ct.conversation_id = c.id AND LOWER(tg.name) IN (${tagParams}))`);
        params.push(...tags.map((s) => s.toLowerCase()));
      } else {
        where.push(`EXISTS (SELECT 1 FROM conversation_tags ct JOIN tags tg ON tg.id = ct.tag_local_id WHERE ct.conversation_id = c.id AND LOWER(tg.name) IN (${tagParams}))`);
        params.push(...tags.map((s) => s.toLowerCase()));
      }
    }
    const rows = this.db
      .prepare(
        `SELECT c.id, c.number, c.subject, c.status, c.remote_created_at,
           (SELECT GROUP_CONCAT(tg.name) FROM conversation_tags ct JOIN tags tg ON tg.id = ct.tag_local_id WHERE ct.conversation_id = c.id) AS tags
         FROM conversations c WHERE ${where.join(' AND ')} ORDER BY c.remote_created_at DESC LIMIT 20`
      )
      .all(...params) as { id: number; number: number; subject: string | null; status: string; remote_created_at: string | null; tags: string | null }[];
    return rows.map((r) => ({ conversationId: r.id, number: r.number, subject: r.subject, status: r.status, tags: r.tags ? r.tags.split(',').filter(Boolean) : [], createdAt: r.remote_created_at }));
  }

  /** All ticket evidence across all ticket nodes for the review drawer (spec #39). */
  private collectMatchingTickets(cid: number, def: SegmentDefinition): RecipientWhyTicket[] {
    const seen = new Map<number, RecipientWhyTicket>();
    const walk = (nodes: SegmentNode[]): void => {
      for (const n of nodes) {
        if (this.isGroup(n)) walk(n.children);
        else if (n.kind === 'ticket') for (const t of this.ticketsForCustomerMatching(cid, n)) if (!seen.has(t.conversationId)) seen.set(t.conversationId, t);
      }
    };
    walk(def.conditions);
    walk(def.exclude);
    return [...seen.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  /** Primary usable email: work > first stored (spec #8 - a customer may have several). */
  primaryEmail(cid: number): string | null {
    const row = this.db
      .prepare(
        `SELECT value FROM customer_emails WHERE customer_id = ? AND value IS NOT NULL AND value <> ''
         ORDER BY CASE WHEN LOWER(COALESCE(type, '')) LIKE '%work%' THEN 0 ELSE 1 END, id LIMIT 1`
      )
      .get(cid) as { value: string } | undefined;
    return row?.value ?? null;
  }

  // ---------------- SQL helpers ----------------

  private ids(sql: string, params: unknown[]): number[] {
    return (this.db.prepare(sql).all(...params) as { cid: number }[]).map((r) => r.cid);
  }
}

function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function describeOp(op: string): string {
  const map: Record<string, string> = {
    equals: '=',
    not_equals: 'is not',
    contains: 'contains',
    not_contains: 'does not contain',
    starts_with: 'starts with',
    ends_with: 'ends with',
    is_empty: 'is empty',
    is_not_empty: 'is set'
  };
  return map[op] ?? op;
}

function describeContactPresence(field: string): string {
  const map: Record<string, string> = {
    has_email: 'has an email address',
    has_phone: 'has a phone number',
    has_multiple_emails: 'has multiple email addresses'
  };
  return map[field] ?? field;
}

function describeHistory(h: HistoryCondition): string {
  const metric: Record<string, string> = {
    ticket_count: 'total tickets',
    open_count: 'open tickets',
    closed_count: 'closed tickets',
    last_contact_within_days: 'contacted within the last (days)',
    first_contact_before_days: 'first contact older than (days)'
  };
  const op = h.op === 'gte' ? 'is at least' : h.op === 'lte' ? 'is at most' : '=';
  return `${metric[h.metric] ?? h.metric} ${op} ${h.value}`;
}
