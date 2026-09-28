import { type ReactNode, useEffect } from 'react';
import { Routes, Route, NavLink, useLocation, useNavigate, Navigate } from 'react-router-dom';
import {
  LayoutDashboard, Inbox, Search, Users, Building2, Bot, AlertTriangle, BookOpen, BookMarked,
  BarChart3, Workflow, HeartPulse, Settings, PanelLeft, Sun, Moon, Command, Megaphone, Bell, Activity, Flame, Boxes, Plug, Network
} from 'lucide-react';
import { useUiStore } from './state/uiStore.js';
import { Toasts } from './components/common/overlays.js';
import { CommandPalette } from './components/common/CommandPalette.js';
import { ServerEventsBridge } from './api/events.js';
import { DashboardPage } from './pages/Dashboard.js';
import { InboxPage } from './pages/Inbox.js';
import { SearchPage } from './pages/SearchPage.js';
import { CustomersPage, CustomerDetailPage } from './pages/Customers.js';
import { OrganizationsPage, OrganizationDetailPage } from './pages/Organizations.js';
import { AiCenterPage } from './pages/AiCenter.js';
import { IssuesPage } from './pages/Issues.js';
import { KnowledgePage } from './pages/Knowledge.js';
import { DocsPage } from './pages/Docs.js';
import { ReportsPage } from './pages/Reports.js';
import { AutomationPage } from './pages/Automation.js';
import { SyncHealthPage } from './pages/SyncHealth.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { OnboardingPage } from './pages/Onboarding.js';
import { OutreachPage } from './pages/Outreach.js';
import { NotificationCenterPage } from './pages/NotificationCenter.js';
import { OperationsCenterPage } from './pages/OperationsCenter.js';
import { IncidentsPage, IncidentDetailPage } from './pages/Incidents.js';
import { CustomObjectsPage } from './pages/CustomObjects.js';
import { ConnectorsPage } from './pages/Connectors.js';
import { GraphExplorerPage } from './pages/GraphExplorer.js';
import { useQuery } from '@tanstack/react-query';
import { api } from './api/client.js';
import { useUnreadNotificationCount } from './api/hooks.js';

function NavItem({ to, icon, label, count }: { to: string; icon: ReactNode; label: string; count?: number }): ReactNode {
  return (
    <NavLink to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      {icon}
      <span className="nav-label">{label}</span>
      {count != null && count > 0 ? <span className="badge-count">{count > 99 ? '99+' : count}</span> : null}
    </NavLink>
  );
}

export function App(): ReactNode {
  const theme = useUiStore((s) => s.theme);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const setCommandPalette = useUiStore((s) => s.setCommandPalette);
  const commandPaletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const location = useLocation();
  const navigate = useNavigate();

  const { data: onboarding } = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api.get<{ step: string; completed: boolean; demo_mode: boolean; sync_state: string; conversations: number }>('/api/onboarding')
  });

  const { data: counts } = useQuery({
    queryKey: ['nav-counts'],
    queryFn: () => api.get<{ total: number }>('/api/conversations?view=active&pageSize=1').then((r) => ({ active: r.total, unassigned: 0 })),
    refetchInterval: 30_000
  });

  // v1.8.0: Notification Center unread badge (SSE-invalidated + 30s refetch).
  const { data: unread } = useUnreadNotificationCount();

  // Keyboard shortcuts (spec #94): Cmd/Ctrl+K search, g+d dashboard, g+i inbox, ? shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPalette(true);
        return;
      }
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        navigate('/search');
      }
      if (e.key === 'g') {
        const handler = (e2: KeyboardEvent): void => {
          // Re-check typing context: focus may have moved into a textarea
          // between the 'g' press and the follow-up key (typing 'd' as the
          // first character of a reply would otherwise navigate away).
          const target = e2.target as HTMLElement | null;
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            window.removeEventListener('keydown', handler);
            return;
          }
          if (e2.key === 'd') navigate('/');
          if (e2.key === 'i') navigate('/inbox');
          if (e2.key === 's') navigate('/sync-health');
          window.removeEventListener('keydown', handler);
        };
        window.addEventListener('keydown', handler, { once: true });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, setCommandPalette]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // First-run experience (spec #100)
  const showOnboarding = onboarding && !onboarding.completed && location.pathname !== '/onboarding';
  // v1.6.0 audit fix: during first-run onboarding the full sidebar rendered
  // around the wizard - every nav item was visible but dead (the guard bounced
  // clicks straight back). Hide the shell while the wizard is active.
  const onboardingActive = onboarding != null && !onboarding.completed;

  return (
    <div className="app-shell">
      {onboardingActive ? null : (
      <nav className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`} aria-label="Main navigation">
        <div className="sidebar-brand">
          <span className="logo">S</span>
          <span>SupportOS</span>
          <button className="btn ghost small" style={{ marginLeft: 'auto' }} aria-label="Toggle sidebar" onClick={toggleSidebar}>
            <PanelLeft size={14} />
          </button>
        </div>
        <NavItem to="/" icon={<LayoutDashboard />} label="Dashboard" />
        <NavItem to="/inbox" icon={<Inbox />} label="Inbox" count={counts?.active} />
        <NavItem to="/notifications" icon={<Bell />} label="Notifications" count={unread?.unread} />
        <NavItem to="/search" icon={<Search />} label="Search" />
        <div className="nav-section">Directory</div>
        <NavItem to="/customers" icon={<Users />} label="Customers" />
        <NavItem to="/organizations" icon={<Building2 />} label="Organizations" />
        <div className="nav-section">Intelligence</div>
        <NavItem to="/ai" icon={<Bot />} label="AI Center" />
        <NavItem to="/issues" icon={<AlertTriangle />} label="Issues" />
        <NavItem to="/incidents" icon={<Flame />} label="Incidents" />
        <NavItem to="/knowledge" icon={<BookOpen />} label="Knowledge" />
        <NavItem to="/docs" icon={<BookMarked />} label="Docs" />
        <NavItem to="/custom-objects" icon={<Boxes />} label="Objects" />
        <NavItem to="/connectors" icon={<Plug />} label="Connectors" />
        <NavItem to="/graph" icon={<Network />} label="Graph" />
        <div className="nav-section">Operations</div>
        <NavItem to="/operations" icon={<Activity />} label="Operations" />
        <NavItem to="/reports" icon={<BarChart3 />} label="Reports" />
        <NavItem to="/outreach" icon={<Megaphone />} label="Outreach" />
        <NavItem to="/automation" icon={<Workflow />} label="Automation" />
        <NavItem to="/sync-health" icon={<HeartPulse />} label="Sync Health" />
        <NavItem to="/settings" icon={<Settings />} label="Settings" />
        <div className="sidebar-footer">
          <button className="btn ghost small" onClick={() => setCommandPalette(true)} aria-label="Open command palette">
            <Command size={12} /> <span className="nav-label">Command</span> <span className="kbd nav-label">⌘K</span>
          </button>
          <button className="btn ghost small mt-8" onClick={toggleTheme} aria-label="Toggle color theme">
            {theme === 'light' ? <Moon size={12} /> : <Sun size={12} />} <span className="nav-label">{theme === 'light' ? 'Dark' : 'Light'} theme</span>
          </button>
        </div>
      </nav>
      )}
      <div className="main-area">
        {showOnboarding ? <Navigate to="/onboarding" replace /> : null}
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/inbox/conversation/:id" element={<InboxPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/customers/:id" element={<CustomerDetailPage />} />
          <Route path="/organizations" element={<OrganizationsPage />} />
          <Route path="/organizations/:id" element={<OrganizationDetailPage />} />
          <Route path="/ai" element={<AiCenterPage />} />
          <Route path="/issues" element={<IssuesPage />} />
          <Route path="/incidents" element={<IncidentsPage />} />
          <Route path="/incidents/:id" element={<IncidentDetailPage />} />
          <Route path="/custom-objects" element={<CustomObjectsPage />} />
          <Route path="/connectors" element={<ConnectorsPage />} />
          <Route path="/graph" element={<GraphExplorerPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/outreach" element={<OutreachPage />} />
          <Route path="/operations" element={<OperationsCenterPage />} />
          <Route path="/notifications" element={<NotificationCenterPage />} />
          <Route path="/automation" element={<AutomationPage />} />
          <Route path="/sync-health" element={<SyncHealthPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          {/* v2.2.1 audit fix: unknown URLs used to redirect silently to the
              dashboard. A proper 404 keeps typos and broken bookmarks honest. */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </div>
      <Toasts />
      <ServerEventsBridge />
      {commandPaletteOpen ? <CommandPalette /> : null}
      <div className="shortcut-bar" aria-hidden="true">
        <span><span className="kbd">⌘K</span> search</span>
        <span><span className="kbd">/</span> quick search</span>
        <span><span className="kbd">g</span><span className="kbd">i</span> inbox</span>
        <span><span className="kbd">g</span><span className="kbd">d</span> dashboard</span>
      </div>
    </div>
  );
}

/** v2.2.1 audit fix: honest 404 for unknown routes (was: silent redirect to
 *  the dashboard, which hid typos and broken bookmarks). */
function NotFoundPage(): ReactNode {
  return (
    <div className="page">
      <div className="card" style={{ maxWidth: 520, margin: '48px auto', textAlign: 'center' }}>
        <h1 className="page-title" style={{ fontSize: 40, margin: 0 }}>404</h1>
        <p className="muted" style={{ margin: '8px 0 16px' }}>This page does not exist. The URL may be mistyped or outdated.</p>
        <a className="btn primary" href="/">Back to the dashboard</a>
      </div>
    </div>
  );
}
