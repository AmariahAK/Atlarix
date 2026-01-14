/**
 * Atlarix Project Language Detector
 * ==================================
 * Auto-detects programming languages used in a project
 * by scanning for indicator files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LANGUAGE_REGISTRY, type LanguageRequirement } from './language_registry';

export interface DetectedLanguage {
    name: string;
    displayName: string;
    icon: string;
    foundIndicators: string[];
    isPrimary: boolean;
}

/**
 * Detect languages used in a project by scanning for indicator files
 */
export async function detectProjectLanguages(projectPath: string): Promise<DetectedLanguage[]> {
    const detected: Map<string, DetectedLanguage> = new Map();

    // Files/folders to check in the root
    let rootFiles: string[] = [];
    try {
        rootFiles = await fs.promises.readdir(projectPath);
    } catch {
        return [];
    }

    for (const [langName, lang] of Object.entries(LANGUAGE_REGISTRY)) {
        const foundIndicators: string[] = [];

        for (const indicator of lang.indicators) {
            // Handle glob patterns like *.csproj
            if (indicator.startsWith('*')) {
                const ext = indicator.slice(1);
                const matching = rootFiles.filter(f => f.endsWith(ext));
                if (matching.length > 0) {
                    foundIndicators.push(...matching);
                }
            } else if (indicator.includes('/')) {
                // Handle path indicators like src/main/java
                const fullPath = path.join(projectPath, indicator);
                try {
                    await fs.promises.access(fullPath);
                    foundIndicators.push(indicator);
                } catch {
                    // Not found
                }
            } else {
                // Simple file/folder name
                if (rootFiles.includes(indicator)) {
                    foundIndicators.push(indicator);
                }
            }
        }

        if (foundIndicators.length > 0) {
            detected.set(langName, {
                name: langName,
                displayName: lang.displayName,
                icon: lang.icon,
                foundIndicators,
                isPrimary: false,
            });
        }
    }

    // Determine primary language(s) based on priority
    const result = Array.from(detected.values());

    // Node.js/Bun/Deno are primary for web projects
    if (detected.has('nodejs') && !detected.has('bun') && !detected.has('deno')) {
        const node = detected.get('nodejs')!;
        node.isPrimary = true;
    } else if (detected.has('bun')) {
        const bun = detected.get('bun')!;
        bun.isPrimary = true;
    } else if (detected.has('deno')) {
        const deno = detected.get('deno')!;
        deno.isPrimary = true;
    }

    // If no JS runtime is primary, first detected is primary
    const hasPrimary = result.some(l => l.isPrimary);
    if (!hasPrimary && result.length > 0) {
        result[0].isPrimary = true;
    }

    return result;
}

/**
 * Get the primary language for a project
 */
export async function getPrimaryLanguage(projectPath: string): Promise<DetectedLanguage | null> {
    const languages = await detectProjectLanguages(projectPath);
    return languages.find(l => l.isPrimary) || languages[0] || null;
}

/**
 * Check if a specific language is used in a project
 */
export async function projectUsesLanguage(projectPath: string, languageName: string): Promise<boolean> {
    const languages = await detectProjectLanguages(projectPath);
    return languages.some(l => l.name === languageName);
}
