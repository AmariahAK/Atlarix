/**
 * Atlarix Language Validator
 * ==========================
 * Validates whether required languages are installed on the system.
 * Used for lazy validation (only check when needed).
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { LANGUAGE_REGISTRY, getLanguage, getAllLanguageNames, type LanguageRequirement } from './language_registry';
import { detectProjectLanguages, type DetectedLanguage } from './project_language_detector';
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

export interface ProjectValidationResult {
    projectPath: string;
    allInstalled: boolean;
    languages: LanguageValidationResult[];
    missingLanguages: LanguageValidationResult[];
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

/**
 * Validate all languages required by a project
 */
export async function validateProjectLanguages(projectPath: string): Promise<ProjectValidationResult> {
    const detectedLanguages = await detectProjectLanguages(projectPath);
    const results: LanguageValidationResult[] = [];

    for (const detected of detectedLanguages) {
        const validation = await validateLanguageInstalled(detected.name);
        results.push(validation);
    }

    const missingLanguages = results.filter(r => !r.installed);

    return {
        projectPath,
        allInstalled: missingLanguages.length === 0,
        languages: results,
        missingLanguages,
    };
}

/**
 * Check all registered languages (for settings page)
 */
export async function checkAllLanguages(): Promise<LanguageValidationResult[]> {
    const results: LanguageValidationResult[] = [];

    for (const langName of getAllLanguageNames()) {
        const result = await validateLanguageInstalled(langName);
        results.push(result);
    }

    return results;
}

/**
 * Quick check if primary languages are ready for a project type
 */
export async function isProjectReady(projectPath: string): Promise<{
    ready: boolean;
    missing: string[];
    message: string;
}> {
    const validation = await validateProjectLanguages(projectPath);

    if (validation.allInstalled) {
        return {
            ready: true,
            missing: [],
            message: 'All required languages are installed.',
        };
    }

    const missingNames = validation.missingLanguages.map(l => l.displayName);

    return {
        ready: false,
        missing: missingNames,
        message: `Missing: ${missingNames.join(', ')}. Install before running.`,
    };
}
