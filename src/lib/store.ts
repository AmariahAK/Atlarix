/**
 * Atlarix Store
 * =============
 * Global state management using Zustand
 */

import { create } from 'zustand';

interface Workspace {
    id: string;
    name: string;
    path: string;
}

interface Model {
    id: string;
    name: string;
    provider: 'ollama' | 'lmstudio' | 'openrouter';
    status: 'connected' | 'disconnected' | 'error';
}

interface User {
    id: string;
    email: string;
    subscription_type: 'free' | 'monthly_pro' | 'annual_pro' | 'annual_license';
    prompts_used_today: number;
    prompts_limit: number;
}

interface AtlarixState {
    // Workspace
    currentWorkspace: Workspace | null;
    workspaces: Workspace[];
    setCurrentWorkspace: (workspace: Workspace | null) => void;
    addWorkspace: (workspace: Workspace) => void;

    // Model
    currentModel: Model | null;
    availableModels: Model[];
    setCurrentModel: (model: Model | null) => void;
    setAvailableModels: (models: Model[]) => void;

    // User
    user: User | null;
    setUser: (user: User | null) => void;

    // UI State
    sidebarCollapsed: boolean;
    setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useAtlarixStore = create<AtlarixState>((set) => ({
    // Workspace
    currentWorkspace: null,
    workspaces: [],
    setCurrentWorkspace: (workspace) => set({ currentWorkspace: workspace }),
    addWorkspace: (workspace) =>
        set((state) => ({
            workspaces: [...state.workspaces, workspace],
            currentWorkspace: workspace,
        })),

    // Model
    currentModel: null,
    availableModels: [],
    setCurrentModel: (model) => set({ currentModel: model }),
    setAvailableModels: (models) => set({ availableModels: models }),

    // User
    user: null,
    setUser: (user) => set({ user }),

    // UI State
    sidebarCollapsed: false,
    setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
}));
