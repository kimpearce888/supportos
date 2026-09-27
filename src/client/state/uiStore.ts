import { create } from 'zustand';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'warning' | 'info';
  message: string;
  detail?: string;
}

interface UiState {
  theme: 'light' | 'dark';
  sidebarCollapsed: boolean;
  contextPaneOpen: boolean;
  toasts: Toast[];
  commandPaletteOpen: boolean;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  setContextPane: (open: boolean) => void;
  setCommandPalette: (open: boolean) => void;
  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
}

let toastId = 1;

export const useUiStore = create<UiState>((set) => ({
  theme: (localStorage.getItem('supportos-theme') as 'light' | 'dark') ?? 'light',
  sidebarCollapsed: localStorage.getItem('supportos-sidebar') === 'collapsed',
  contextPaneOpen: true,
  toasts: [],
  commandPaletteOpen: false,
  toggleTheme: () =>
    set((s) => {
      const theme = s.theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('supportos-theme', theme);
      return { theme };
    }),
  toggleSidebar: () =>
    set((s) => {
      const sidebarCollapsed = !s.sidebarCollapsed;
      localStorage.setItem('supportos-sidebar', sidebarCollapsed ? 'collapsed' : 'open');
      return { sidebarCollapsed };
    }),
  setContextPane: (open) => set({ contextPaneOpen: open }),
  setCommandPalette: (open) => set({ commandPaletteOpen: open }),
  pushToast: (t) =>
    set((s) => {
      const id = toastId++;
      setTimeout(() => set((s2) => ({ toasts: s2.toasts.filter((x) => x.id !== id) })), t.kind === 'error' ? 10000 : 5000);
      return { toasts: [...s.toasts, { ...t, id }] };
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}));
