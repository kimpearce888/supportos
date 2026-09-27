import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Sparkles, Database, Bot, Boxes, Rocket } from 'lucide-react';
import { api } from '../api/client.js';
import { Spinner, KV } from '../components/common/ui.js';
import { useUiStore } from '../state/uiStore.js';

const STEPS = ['welcome', 'helpscout', 'sync', 'lmstudio', 'qdrant', 'done'] as const;
type Step = (typeof STEPS)[number];

export function OnboardingPage(): ReactNode {
  const [step, setStep] = useState<Step>('welcome');
  const navigate = useNavigate();
  const pushToast = useUiStore((s) => s.pushToast);
  const { data: onboarding, refetch } = useQuery({ queryKey: ['onboarding'], queryFn: () => api.get<{ demo_mode: boolean; hs_configured: boolean; hs_authenticated: boolean; sync_state: string; conversations: number }>('/api/onboarding') });
  const { data: lmTest } = useQuery({ queryKey: ['lm-test-onboarding'], queryFn: () => api.post<{ ok: boolean; connected: boolean; models: string[]; message: string }>('/api/settings/lmstudio/test').catch(() => ({ ok: false, connected: false, models: [], message: 'LM Studio not reachable' })), retry: false });
  const { data: qdrantTest } = useQuery({ queryKey: ['qdrant-test-onboarding'], queryFn: () => api.post<{ ok: boolean; connected: boolean; message: string }>('/api/settings/qdrant/test').catch(() => ({ ok: false, connected: false, message: 'Qdrant not reachable' })), retry: false });

  const connectClientCreds = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/oauth/client-credentials'),
    onSuccess: (r) => {
      pushToast({ kind: r.ok ? 'success' : 'error', message: r.message });
      void refetch();
    }
  });

  const startDemo = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/demo/enable'),
    onSuccess: () => {
      pushToast({ kind: 'success', message: 'Demo mode enabled. Starting demo sync…' });
      void api.post('/api/sync/initial');
      // v1.6.0 audit fix: the step never advanced after enabling demo mode - the
      // user was stranded on 'Connect Help Scout' with only a toast. Land them on
      // the sync step where the live progress (state + conversation count) shows
      // the demo data filling in.
      setStep('sync');
      setTimeout(() => void refetch(), 2000);
    }
  });

  const startSync = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/sync/initial'),
    onSuccess: (r) => {
      pushToast({ kind: 'success', message: r.message });
      setStep('lmstudio');
    }
  });

  const queryClient = useQueryClient();
  const finish = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/api/onboarding/complete'),
    onSuccess: () => {
      // v1.6.0 audit fix (finish race): invalidating the ['onboarding'] query and
      // navigating immediately let the App guard re-redirect to /onboarding with
      // STALE data (completed=false), remounting the wizard at step 1 - every
      // user who clicked 'Open Dashboard' saw the wizard restart. The cache is
      // updated optimistically FIRST, so the guard sees completed=true instantly.
      queryClient.setQueryData(['onboarding'], (prev: { step: string; completed: boolean; demo_mode: boolean; sync_state: string; conversations: number } | undefined) =>
        prev ? { ...prev, completed: true } : prev
      );
      void queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      navigate('/');
    }
  });

  if (!onboarding) return <div className="page"><Spinner /></div>;
  const stepIndex = STEPS.indexOf(step);

  return (
    <div className="page">
      <div className="onboarding-step card">
        <div className="flex mb-16" style={{ gap: 6 }}>
          {STEPS.map((s, i) => (
            <span key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= stepIndex ? 'var(--accent)' : 'var(--bg-sunken)' }} />
          ))}
        </div>
        {step === 'welcome' ? (
          <>
            <h1 className="page-title"><Rocket size={22} style={{ display: 'inline', verticalAlign: 'middle' }} /> Welcome to SupportOS</h1>
            <p className="page-subtitle">A local-first support operating system for your Help Scout mailbox: local mirror, fast search, analytics, and local AI assistance. Your data stays on your machine - no cloud AI, no cloud vector database.</p>
            <ul className="check-list text-sm">
              <li><Database size={14} /> SQLite is the canonical local database (WAL + FTS5)</li>
              <li><Bot size={14} /> LM Studio provides local AI (optional - the app works without it)</li>
              <li><Boxes size={14} /> Qdrant adds semantic search on top of keyword search (optional)</li>
              <li><CheckCircle2 size={14} /> AI never sends customer replies automatically</li>
            </ul>
            <div className="flex mt-16">
              <button className="btn primary" onClick={() => setStep('helpscout')}>Get started</button>
            </div>
          </>
        ) : null}

        {step === 'helpscout' ? (
          <>
            <h1 className="page-title">Connect Help Scout</h1>
            {onboarding.demo_mode ? (
              <div className="alert warn">LOCAL_DEMO_MODE is ON - you can explore everything with a simulated mailbox right now.</div>
            ) : (
              <p className="text-sm">
                Create an OAuth2 app in Help Scout (Your Profile → My Apps) with redirect URI <span className="mono">http://localhost:3000/oauth/callback</span>, then set <span className="mono">HELPSCOUT_CLIENT_ID</span> and <span className="mono">HELPSCOUT_CLIENT_SECRET</span> in <span className="mono">.env</span> and restart. Or connect instantly with Client Credentials for a personal integration.
              </p>
            )}
            <KV k="Credentials" v={onboarding.hs_configured || onboarding.demo_mode ? <span className="badge ok">configured</span> : <span className="badge err">missing (.env)</span>} />
            <KV k="Authenticated" v={onboarding.hs_authenticated ? <span className="badge ok">yes</span> : <span className="badge">not yet</span>} />
            <div className="flex mt-16 wrap">
              {onboarding.demo_mode ? (
                <button className="btn primary" onClick={() => startDemo.mutate()} disabled={startDemo.isPending}>
                  <Sparkles size={13} /> Use the simulated mailbox (demo)
                </button>
              ) : (
                <button className="btn primary" onClick={() => connectClientCreds.mutate()} disabled={!onboarding.hs_configured || connectClientCreds.isPending}>
                  Connect with Client Credentials
                </button>
              )}
              <button className="btn" onClick={() => setStep('sync')}>Continue anyway →</button>
            </div>
          </>
        ) : null}

        {step === 'sync' ? (
          <>
            <h1 className="page-title">Initial synchronization</h1>
            <p className="text-sm">Downloads your account, inboxes, customers, conversations and threads into the local mirror. Large mailboxes take a while - the app stays usable and progress is visible in Sync Health.</p>
            <KV k="Sync state" v={<span className="badge">{onboarding.sync_state}</span>} />
            <KV k="Conversations locally" v={onboarding.conversations} />
            <div className="flex mt-16">
              <button className="btn primary" onClick={() => startSync.mutate()} disabled={startSync.isPending}>Start initial sync</button>
              <button className="btn" onClick={() => setStep('lmstudio')}>Skip for now →</button>
            </div>
          </>
        ) : null}

        {step === 'lmstudio' ? (
          <>
            <h1 className="page-title"><Bot size={20} style={{ display: 'inline', verticalAlign: 'middle' }} /> Configure LM Studio</h1>
            <p className="text-sm">
              Install LM Studio, load a chat model (e.g. a 7B instruct model), then Developer → Start Server on port 1234. Optionally load an embedding model (e.g. nomic-embed) for semantic search. Everything runs on your machine.
            </p>
            <KV k="Connection" v={lmTest?.connected ? <span className="badge ok">reachable ({lmTest.models.length} models)</span> : <span className="badge err">not reachable</span>} />
            {!lmTest?.connected ? <div className="alert warn mt-8">{lmTest?.message}</div> : null}
            <div className="flex mt-16">
              <button className="btn" onClick={() => setStep('qdrant')}>Continue →</button>
            </div>
            <p className="text-xs muted mt-8">AI is optional: search, analytics, the inbox and all ticket operations work without it.</p>
          </>
        ) : null}

        {step === 'qdrant' ? (
          <>
            <h1 className="page-title"><Boxes size={20} style={{ display: 'inline', verticalAlign: 'middle' }} /> Optional: Qdrant</h1>
            <p className="text-sm">Run Qdrant locally (<span className="mono">docker run -p 6333:6333 qdrant/qdrant</span>) to enable semantic search. Without it, keyword search (SQLite FTS5) remains fully functional.</p>
            <KV k="Connection" v={qdrantTest?.connected ? <span className="badge ok">reachable</span> : <span className="badge">offline (fallback active)</span>} />
            <div className="flex mt-16">
              <button className="btn primary" onClick={() => setStep('done')}>Continue →</button>
            </div>
          </>
        ) : null}

        {step === 'done' ? (
          <>
            <h1 className="page-title">You're ready</h1>
            <p className="text-sm">Open the dashboard to see your synchronized support data. Press <span className="kbd">⌘K</span> anytime for global search.</p>
            <div className="flex mt-16">
              <button className="btn primary" onClick={() => finish.mutate()}>Open Dashboard</button>
            </div>
          </>
        ) : null}

        <div className="flex mt-16" style={{ justifyContent: 'space-between' }}>
          <button className="btn ghost small" disabled={stepIndex === 0} onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)] ?? 'welcome')}>← Back</button>
          <span className="text-xs muted" style={{ alignSelf: 'center' }}>step {stepIndex + 1} of {STEPS.length}</span>
        </div>
      </div>
    </div>
  );
}
