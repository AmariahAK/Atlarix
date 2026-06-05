/**
 * Atlarix Language Validator
 * ==========================
 * Validates whether required languages are installed on the system.
 * Used for lazy validation (only check when needed).
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getLanguage } from './language_registry';
import log from 'electron-log';

const execAsync = promisify(exec);
const logger = log.scope('language-validator');

export interface LanguageValidationResult {
    language: string;
    displayName: string;
    icon: string;
    installed: boolean;
    version?: string;
    error?: string;
    installUrl: string;
}

/**
 * Validate if a specific language is installed
 */
export async function validateLanguageInstalled(languageName: string): Promise<LanguageValidationResult> {
    const lang = getLanguage(languageName);

    if (!lang) {
        return {
            language: languageName,
            displayName: languageName,
            icon: '❓',
            installed: false,
            error: `Unknown language: ${languageName}`,
            installUrl: '',
        };
    }

    try {
        const { stdout, stderr } = await execAsync(lang.checkCommand, {
            timeout: 5000,
            encoding: 'utf-8',
        });

        const output = (stdout || stderr).trim();

        // Extract version from output (usually the first line)
        const versionMatch = output.match(/(\d+\.\d+(\.\d+)?)/);
        const version = versionMatch ? versionMatch[0] : output.split('\n')[0];

        logger.debug(`[${lang.displayName}] Installed - version: ${version}`);

        return {
            language: lang.name,
            displayName: lang.displayName,
            icon: lang.icon,
            installed: true,
            version,
            installUrl: lang.installUrl,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug(`[${lang.displayName}] Not installed - ${errorMessage}`);

        return {
            language: lang.name,
            displayName: lang.displayName,
            icon: lang.icon,
            installed: false,
            error: `${lang.displayName} not found`,
            installUrl: lang.installUrl,
        };
    }
}

