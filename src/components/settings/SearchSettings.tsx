/**
 * Search Settings Component
 * =========================
 * UI for configuring SearxNG search settings
 * v1: Auto-Docker setup only (manual external config coming later)
 */

import { SearxngSetup } from "./SearxngSetup";

export function SearchSettings() {
    return (
        <div className="space-y-4">
            {/* Auto-Setup via Docker - the main (and only for v1) option */}
            <SearxngSetup />

            {/* Manual configuration for external endpoints - TBD for v2 */}
            {/* <ExternalSearxngConfig /> */}
        </div>
    );
}
