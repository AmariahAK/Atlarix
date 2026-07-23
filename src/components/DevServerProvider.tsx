/**
 * DevServerProvider
 * =================
 * Subscribes to dev server terminal output and browser error parsing only.
 * Does not probe workspaces or auto-start servers — use useDevServer().start().
 */

import { useEffect } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { selectedAppIdAtom } from '@/atoms/appAtoms';
import {
  devServerUrlAtom,
  terminalOutputsAtom,
  type TerminalOutput,
  browserErrorsAtom,
} from '@/atoms/sourceAtoms';
import { IpcClient } from '@/ipc/ipc_client';
import { useBrowserErrorListener } from '@/hooks/useBrowserErrorListener';
import { useBrowserPanelRequest } from '@/hooks/useBrowserPanelRequest';
import { deduplicateErrors, type ParsedError } from '@/lib/devServerErrorParser';
import { TerminalIntelligence } from '@/lib/terminal-intelligence';

export function DevServerProvider({ children }: { children: React.ReactNode }) {
    const workspaceId = useAtomValue(selectedAppIdAtom);
    const setDevServerUrl = useSetAtom(devServerUrlAtom);
    const setTerminalOutputs = useSetAtom(terminalOutputsAtom);
    const setBrowserErrors = useSetAtom(browserErrorsAtom);

    useBrowserErrorListener();
    // Agent asks for the Browser panel (see useBrowserPanelRequest) — must be
    // mounted here, not in BrowserPanel, since it fires while that panel is shut.
    useBrowserPanelRequest();

    useEffect(() => {
        if (!workspaceId) {
            setDevServerUrl(null);
        }
    }, [workspaceId, setDevServerUrl]);

    useEffect(() => {
        const ipc = IpcClient.getInstance();
        const unsubscribe = ipc.onDevServerOutput((payload) => {
            const terminalOutput: TerminalOutput = {
                operationId: `dev-server-${payload.workspaceId}`,
                command: `npm run dev (${payload.framework})`,
                output: payload.fullOutput,
                status: payload.status === 'running' ? 'running' : 'completed',
                startTime: payload.timestamp,
            };

            setTerminalOutputs((prev) => {
                const next = new Map(prev);
                next.set(terminalOutput.operationId, terminalOutput);
                return next;
            });

            const parsedErrors = TerminalIntelligence.parse(payload.output);

            setBrowserErrors((prev) => {
                const runtimeErrors = (prev as ParsedError[]).filter(
                    (e) => e.framework === 'browser',
                );
                const uniqueBuildErrors =
                    parsedErrors.length > 0
                        ? deduplicateErrors([] as ParsedError[], parsedErrors)
                        : [];
                return [...runtimeErrors, ...uniqueBuildErrors] as ParsedError[];
            });
        });

        return unsubscribe;
    }, [setTerminalOutputs, setBrowserErrors]);

    useEffect(() => {
        return () => {
            try {
                IpcClient.getInstance()
                    .listRunningDevServers()
                    .then((response) => {
                        if (response.success && response.servers.length > 0) {
                            response.servers.forEach((s) => {
                                IpcClient.getInstance()
                                    .stopDevServer(s.workspaceId)
                                    .catch(() => {});
                            });
                        }
                    })
                    .catch(() => {});
            } catch {
                // IPC may be unavailable during teardown
            }
        };
    }, []);

    return <>{children}</>;
}
