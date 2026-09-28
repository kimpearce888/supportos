import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { AtSign } from 'lucide-react';
import { useMentionDirectory } from '../../api/hooks.js';

/**
 * MentionTextarea (v1.8.0, plan Phase 13): a plain-text textarea with
 * @autocomplete for agents and teams.
 *
 * - Typing '@' opens a suggestion popup (max 8 entries) filtered
 *   case-insensitively; ArrowUp/Down navigate, Enter/Tab complete, Escape
 *   closes. Completion inserts the exact mention name (a single word when
 *   possible - the parser matches full names too, but single tokens are the
 *   unambiguous form).
 * - The control is a CONTROLLED textarea: the value never mutates beyond
 *   what the user typed plus the completed token; there is no hidden state.
 * - Only names from the Help Scout identity mirror are offered - we never
 *   invent mention targets.
 */
interface DirectoryEntry {
  token: string;
  display: string;
  kind: 'user' | 'team';
}

export function MentionTextarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  style,
  onSubmit,
  id
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  style?: CSSProperties;
  onSubmit?: () => void;
  id?: string;
}): ReactNode {
  const { data: directory } = useMentionDirectory();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [active, setActive] = useState(0);
  const [popupOpen, setPopupOpen] = useState(false);

  const entries = useMemo<DirectoryEntry[]>(() => {
    const list: DirectoryEntry[] = [];
    for (const u of directory?.users ?? []) {
      if (u.mention) list.push({ token: u.mention, display: `${u.display_name} (@${u.mention})`, kind: 'user' });
      else {
        const first = u.display_name.split(' ')[0] ?? u.display_name;
        list.push({ token: first.replace(/[^A-Za-z0-9._-]/g, ''), display: u.display_name, kind: 'user' });
      }
    }
    for (const t of directory?.teams ?? []) list.push({ token: t.name, display: `${t.name} (team)`, kind: 'team' });
    return list;
  }, [directory]);

  const query = useMemo<{ text: string; start: number } | null>(() => {
    const el = ref.current;
    if (el == null) return null;
    const upto = value.slice(0, el.selectionStart ?? value.length);
    const m = /(?:^|\s)@([A-Za-z0-9._-]*)$/.exec(upto);
    if (!m) return null;
    return { text: m[1] ?? '', start: (el.selectionStart ?? value.length) - (m[1]?.length ?? 0) - 1 };
    // popupOpen intentionally re-evaluates the caret query: opening the popup
    // after a blur/close needs a fresh lookup against the current caret.
  }, [value, popupOpen]);

  const matches = useMemo<DirectoryEntry[]>(() => {
    if (!query) return [];
    const q = query.text.toLowerCase();
    return entries.filter((e) => e.token.toLowerCase().startsWith(q) || e.display.toLowerCase().includes(q)).slice(0, 8);
  }, [query, entries]);

  const complete = (entry: DirectoryEntry): void => {
    const el = ref.current;
    if (!query || !el) return;
    const caret = el.selectionStart ?? value.length;
    const after = value.slice(caret);
    const next = `${value.slice(0, query.start)}@${entry.token}${after.startsWith(' ') || after === '' ? '' : ' '}${after}`;
    onChange(next);
    setPopupOpen(false);
    requestAnimationFrame(() => {
      const pos = query.start + 1 + entry.token.length + 1;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (popupOpen && matches.length > 0 && query) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const entry = matches[Math.min(active, matches.length - 1)];
        if (entry) complete(entry);
        return;
      }
      if (e.key === 'Escape') {
        setPopupOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="mention-input-wrap" style={style}>
      <textarea
        id={id}
        ref={ref}
        className="input"
        rows={rows}
        value={value}
        placeholder={placeholder ?? 'Type @ to mention a teammate or team'}
        onChange={(e) => {
          onChange(e.target.value);
          setPopupOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setPopupOpen(false), 150)}
      />
      {popupOpen && matches.length > 0 ? (
        <div className="mention-popup" role="listbox">
          <div className="mention-popup-head"><AtSign size={10} /> mentions</div>
          {matches.map((m, i) => (
            <button
              key={`${m.kind}-${m.token}`}
              type="button"
              className={`mention-option ${i === active ? 'active' : ''}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(m);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {m.display}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
