/**
 * useUpgrade Hook
 * ================
 * Provides consistent upgrade handling across the app.
 * Opens LemonSqueezy checkout with user email prefilled.
 * Shows error if user not signed in.
 */

import { useCallback, useState } from 'react';
import { showError } from '@/lib/toast';

interface UpgradeResult {
    success: boolean;
    error?: string;
    message?: string;
}

export function useUpgrade() {
    const [isLoading, setIsLoading] = useState(false);

    const handleUpgrade = useCallback(async (): Promise<UpgradeResult> => {
        setIsLoading(true);

        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) {
                const error = 'Unable to access upgrade. Please restart the app.';
                showError(error);
                return { success: false, error };
            }

            const result = await ipcRenderer.invoke('auth:upgrade') as UpgradeResult;

            if (!result.success && result.error) {
                // User needs to sign in first - show toast
                showError(result.error);
            }

            return result;
        } catch (error) {
            const errorMessage = 'Failed to open upgrade page. Please try again.';
            showError(errorMessage);
            return { success: false, error: errorMessage };
        } finally {
            setIsLoading(false);
        }
    }, []);

    return {
        handleUpgrade,
        isLoading,
    };
}

/**
 * Standalone upgrade function for use in components without hooks
 * (e.g., in event handlers where hooks can't be used)
 */
export async function triggerUpgrade(): Promise<UpgradeResult> {
    try {
        const ipcRenderer = window.electron?.ipcRenderer;
        if (!ipcRenderer?.invoke) {
            const error = 'Unable to access upgrade. Please restart the app.';
            showError(error);
            return { success: false, error };
        }

        const result = await ipcRenderer.invoke('auth:upgrade') as UpgradeResult;

        if (!result.success && result.error) {
            // User needs to sign in first - show toast
            showError(result.error);
        }

        return result;
    } catch (error) {
        const errorMessage = 'Failed to open upgrade page. Please try again.';
        showError(errorMessage);
        return { success: false, error: errorMessage };
    }
}

/** Open Workforce checkout ($79/mo, teams). Use when user chooses Workforce from upgrade flow. */
export async function triggerUpgradeWorkforce(): Promise<UpgradeResult> {
    try {
        const ipcRenderer = window.electron?.ipcRenderer;
        if (!ipcRenderer?.invoke) {
            showError('Unable to access upgrade. Please restart the app.');
            return { success: false, error: 'Unable to access upgrade' };
        }
        const result = await ipcRenderer.invoke('auth:upgrade-workforce') as UpgradeResult;
        if (!result.success && result.error) showError(result.error);
        return result;
    } catch (error) {
        showError('Failed to open upgrade page. Please try again.');
        return { success: false, error: 'Failed to open upgrade page' };
    }
}

export default useUpgrade;
