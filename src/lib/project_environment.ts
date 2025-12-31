/**
 * Project Environment Detection
 * ==============================
 * Reads package.json to detect project framework, scripts, and dependencies.
 * Prevents AI hallucination by providing accurate project context.
 */

import * as fs from "fs/promises";
import * as path from "path";
import log from "electron-log";

const logger = log.scope("project-environment");

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

export type Framework = 'vite' | 'next' | 'cra' | 'nuxt' | 'astro' | 'remix' | 'angular' | 'vue' | 'svelte' | 'express' | 'fastify' | 'nest' | 'unknown';

export interface ProjectScripts {
    dev?: string;
    start?: string;
    build?: string;
    test?: string;
    lint?: string;
    format?: string;
}

export interface ProjectEnvironment {
    /** Detected framework */
    framework: Framework;

    /** Available npm scripts */
    scripts: ProjectScripts;

    /** Recommended dev command (e.g., "npm run dev" or "npm start") */
    devCommand: string | null;

    /** Recommended build command */
    buildCommand: string | null;

    /** Production dependencies */
    dependencies: string[];

    /** Development dependencies */
    devDependencies: string[];

    /** Package name */
    name?: string;

    /** Package version */
    version?: string;

    /** Whether package.json exists */
    hasPackageJson: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// DETECTION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Detect framework from package.json dependencies.
 */
function detectFramework(dependencies: Record<string, string>, devDependencies: Record<string, string>): Framework {
    const allDeps = { ...dependencies, ...devDependencies };

    // Check in order of specificity
    if (allDeps['next']) return 'next';
    if (allDeps['nuxt']) return 'nuxt';
    if (allDeps['@remix-run/react']) return 'remix';
    if (allDeps['astro']) return 'astro';
    if (allDeps['@angular/core']) return 'angular';
    if (allDeps['svelte']) return 'svelte';
    if (allDeps['@nestjs/core']) return 'nest';
    if (allDeps['fastify']) return 'fastify';
    if (allDeps['express']) return 'express';

    // Vue detection (check for vite first)
    if (allDeps['vite']) {
        if (allDeps['vue']) return 'vue';
        return 'vite';
    }

    // Create React App detection
    if (allDeps['react-scripts']) return 'cra';

    // Generic Vue
    if (allDeps['vue']) return 'vue';

    return 'unknown';
}

/**
 * Determine the best dev command for a project.
 */
function determineDevCommand(scripts: Record<string, string>, framework: Framework): string | null {
    // Priority order: dev > start > serve
    if (scripts.dev) return 'npm run dev';
    if (scripts.start) return 'npm start';
    if (scripts.serve) return 'npm run serve';

    // Framework-specific fallbacks
    switch (framework) {
        case 'next':
            return 'npx next dev';
        case 'vite':
            return 'npx vite';
        case 'cra':
            return 'npx react-scripts start';
        case 'astro':
            return 'npx astro dev';
        default:
            return null;
    }
}

/**
 * Determine the build command for a project.
 */
function determineBuildCommand(scripts: Record<string, string>, framework: Framework): string | null {
    if (scripts.build) return 'npm run build';

    // Framework-specific fallbacks
    switch (framework) {
        case 'next':
            return 'npx next build';
        case 'vite':
            return 'npx vite build';
        case 'cra':
            return 'npx react-scripts build';
        case 'astro':
            return 'npx astro build';
        default:
            return null;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN FUNCTION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Detect project environment from workspace path.
 * Reads package.json and extracts relevant information.
 */
export async function detectProjectEnvironment(workspacePath: string): Promise<ProjectEnvironment> {
    const packageJsonPath = path.join(workspacePath, 'package.json');

    try {
        const content = await fs.readFile(packageJsonPath, 'utf-8');
        const pkg = JSON.parse(content);

        const dependencies = pkg.dependencies || {};
        const devDependencies = pkg.devDependencies || {};
        const scripts = pkg.scripts || {};

        const framework = detectFramework(dependencies, devDependencies);

        const result: ProjectEnvironment = {
            framework,
            scripts: {
                dev: scripts.dev,
                start: scripts.start,
                build: scripts.build,
                test: scripts.test,
                lint: scripts.lint,
                format: scripts.format || scripts.prettier,
            },
            devCommand: determineDevCommand(scripts, framework),
            buildCommand: determineBuildCommand(scripts, framework),
            dependencies: Object.keys(dependencies),
            devDependencies: Object.keys(devDependencies),
            name: pkg.name,
            version: pkg.version,
            hasPackageJson: true,
        };

        logger.log(`[detectProjectEnvironment] ${workspacePath}: ${framework} project`);

        return result;
    } catch (error) {
        logger.warn(`[detectProjectEnvironment] No package.json found in ${workspacePath}`);

        return {
            framework: 'unknown',
            scripts: {},
            devCommand: null,
            buildCommand: null,
            dependencies: [],
            devDependencies: [],
            hasPackageJson: false,
        };
    }
}

/**
 * Get a human-readable summary of the project environment.
 */
export function getProjectSummary(env: ProjectEnvironment): string {
    if (!env.hasPackageJson) {
        return 'No package.json found in this directory.';
    }

    const lines: string[] = [];

    if (env.name) {
        lines.push(`Project: ${env.name}${env.version ? ` v${env.version}` : ''}`);
    }

    lines.push(`Framework: ${env.framework}`);

    if (env.devCommand) {
        lines.push(`Dev command: ${env.devCommand}`);
    }

    if (env.buildCommand) {
        lines.push(`Build command: ${env.buildCommand}`);
    }

    if (env.scripts.test) {
        lines.push(`Test command: npm test`);
    }

    lines.push(`Dependencies: ${env.dependencies.length} production, ${env.devDependencies.length} dev`);

    return lines.join('\n');
}

export default detectProjectEnvironment;
