import { type ReactNode, useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, CornerDownLeft } from 'lucide-react';
import { useUiStore } from '../../state/uiStore.js';
import { api } from '../../api/client.js';
import type { SearchHit, SearchResponse } from '../../../shared/types.js';

export function CommandPalette(): ReactNode {
  const setCommandPalette = useUiStore((s) => s.setCommandPalette);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [selected, setSelected] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .post<SearchResponse>('/api/search', { query, scope: 'all' })
        .then((r) => {
          setResults(r.hits.slice(0, 12));
          setSelected(0);
        })
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const go = (hit: SearchHit | undefined): void => {
    if (!hit) return;
    setCommandPalette(false);
    navigate(hit.href);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setCommandPalette(false)}>
      <div className="modal" style={{ width: 'min(640px, 94vw)' }} role="dialog" aria-label="Command palette">
        <div style={{ display: 'flex', gap: 8, padding: 12, borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
          <Search size={16} className="muted" />
          <input
            ref={inputRef}
            className="input"
            style={{ border: 'none', outline: 'none', fontSize: 15 }}
            placeholder="Search tickets, customers, knowledge, issues…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelected((s) => Math.min(results.length - 1, s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected((s) => Math.max(0, s - 1));
              } else if (e.key === 'Enter') {
                go(results[selected]);
              } else if (e.key === 'Escape') {
                setCommandPalette(false);
              }
            }}
          />
        </div>
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {results.map((hit, i) => (
            <div
              key={`${hit.scope}-${hit.id}`}
              className={`conversation-item ${i === selected ? 'selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => go(hit)}
            >
              <div className="conv-subject">
                <span className="badge">{hit.scope}</span>
                <span>{hit.title}</span>
              </div>
              {hit.snippet ? <div className="conv-preview">{hit.snippet}</div> : null}
            </div>
          ))}
          {query && results.length === 0 ? <div className="empty-state">No results for “{query}”</div> : null}
          {!query ? (
            <div style={{ padding: 14 }} className="muted text-sm">
              Type to search across tickets, customers, knowledge, known issues, saved replies and AI analyses. <span className="kbd">↵</span> open · <span className="kbd">↑↓</span> navigate
            </div>
          ) : null}
        </div>
        {results.length > 0 ? (
          <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
            <span className="muted text-xs">
              <CornerDownLeft size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> open selected
            </span>
            <span className="muted text-xs">{results.length} results</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
