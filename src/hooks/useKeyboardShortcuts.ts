/**
 * useKeyboardShortcuts
 * ====================
 * Global keyboard shortcuts for panel and UI control
 * 
 * Shortcuts:
 * - CMD/CTRL + B: Toggle right panel visibility
 * - CMD/CTRL + /: Toggle left sidebar (handled by SidebarProvider)
 * - CMD/CTRL + [: Narrow right panel
 * - CMD/CTRL + ]: Widen right panel
 * - ESC: Close right panel if open
 */

import { useEffect } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { rightPanelVisibleAtom, rightPanelWidthAtom } from '@/atoms/sourceAtoms';

export function useKeyboardShortcuts() {
    const [isPanelVisible, setIsPanelVisible] = useAtom(rightPanelVisibleAtom);
    const setPanelWidth = useSetAtom(rightPanelWidthAtom);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            const cmdKey = isMac ? e.metaKey : e.ctrlKey;

            // CMD/CTRL + B: Toggle panel visibility
            if (cmdKey && e.key.toLowerCase() === 'b' && !e.shiftKey) {
                e.preventDefault();
                setIsPanelVisible(prev => !prev);
            }

            // CMD/CTRL + Shift + P: Panel switcher (placeholder)
            if (cmdKey && e.shiftKey && e.key.toLowerCase() === 'p') {
                e.preventDefault();
                // Future: Open panel type switcher modal
                console.log('[Shortcuts] Panel switcher triggered');
            }

            // ESC: Close panel
            if (e.key === 'Escape' && isPanelVisible) {
                e.preventDefault();
                setIsPanelVisible(false);
            }

            // CMD/CTRL + [: Narrow panel
            if (cmdKey && e.key === '[') {
                e.preventDefault();
                setPanelWidth(prev => Math.max(300, prev - 50));
            }

            // CMD/CTRL + ]: Widen panel
            if (cmdKey && e.key === ']') {
                e.preventDefault();
                setPanelWidth(prev => Math.min(600, prev + 50));
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isPanelVisible, setIsPanelVisible, setPanelWidth]);
}

export default useKeyboardShortcuts;
