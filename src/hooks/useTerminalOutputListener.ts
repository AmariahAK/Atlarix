/**
 * useTerminalOutputListener
 * ==========================
 * Hook to subscribe to terminal output events from command execution.
 * Updates terminalOutputsAtom when commands start, update, or complete.
 */

import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { terminalOutputsAtom, type TerminalOutput } from '@/atoms/sourceAtoms';
import { IpcClient } from '@/ipc/ipc_client';

export function useTerminalOutputListener(chatId: number) {
    const setTerminalOutputs = useSetAtom(terminalOutputsAtom);

    useEffect(() => {
        // Skip for ephemeral chats (negative IDs)
        if (chatId < 0) return;

        const ipc = IpcClient.getInstance();

        const unsubscribe = ipc.onTerminalOutput(chatId, (payload) => {
            setTerminalOutputs((prev) => {
                const next = new Map(prev);
                const existing = next.get(payload.commandId);

                const output: TerminalOutput = {
                    operationId: payload.commandId,
                    command: payload.command,
                    output: payload.output || '',
                    status: payload.status,
                    exitCode: payload.exitCode,
                    startTime: existing?.startTime || Date.now(),
                    duration: existing?.startTime
                        ? Date.now() - existing.startTime
                        : undefined,
                };

                next.set(payload.commandId, output);
                return next;
            });
        });

        return unsubscribe;
    }, [chatId, setTerminalOutputs]);
}

export default useTerminalOutputListener;
