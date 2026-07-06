/**
 * Workspace Analyzer
 * ==================
 * Analyzes workspace structure and detects language/framework for chat context,
 * diagrams, and the file-tree blueprint fallback.
 *
 * Structure (files, functions, classes, per-file language) comes from the
 * shared Universal Ctags symbol index (`ensureSymbolIndex`) — language-agnostic,
 * cached, and usually already warm from the blueprint/search paths. The only
 * content scanning left here is a universal import-pattern pass (for the
 * dependency graph / hub files), which is syntax-shaped rather than
 * language-gated. There is deliberately NO per-language extraction logic and
 * NO extension allowlist in this module.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import log from 'electron-log';
import {
    loadIgnorerForProject,
    isRelPathIgnored,
} from '@/lib/atlarix/atlarix-ignore';
import { isUnderMemoryPressure, WORKSPACE_LARGE_FILE_THRESHOLD } from '@/constants/settings_constants';
import { ensureSymbolIndex } from '@/lib/index/ctags-index';
import type { SymbolRecord } from '@/lib/index/symbol-types';

const logger = log.scope('workspace-analyzer');

export interface AnalyzedFile {
    path: string;
    relativePath: string;
    language: string;
    type: 'component' | 'service' | 'utility' | 'config' | 'test' | 'model' | 'controller' | 'module';
    imports: string[];
    exports: string[];
    functions: string[];
    classes: string[];
}

export interface Dependency {
    from: string;
    to: string;
    type: 'import' | 'call' | 'extends';
}

export interface Cluster {
    id: string;
    name: string;
    files: string[];
    purpose: string;
    entryPoints: string[];
}

export interface WorkspaceAnalysis {
    workspacePath: string;
    /** Config-probe result, else dominant ctags language, else 'mixed'. Free-form (any ctags language). */
    language: string;
    framework?: 'react' | 'next' | 'vue' | 'express' | 'fastapi' | 'django' | 'flask' | 'spring';
    packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun' | 'poetry' | 'pip' | 'cargo' | 'go' | 'maven' | 'gradle';
    files: AnalyzedFile[];
    dependencies: Dependency[];
    clusters: Cluster[];
    entryPoints: string[];
    metadata: {
        totalFiles: number;
        languages: string[];
        hubFiles: string[];
    };
}

function emptyAnalysis(workspacePath: string): WorkspaceAnalysis {
    return {
        workspacePath,
        language: 'mixed',
        files: [],
        dependencies: [],
        clusters: [],
        entryPoints: [],
        metadata: {
            totalFiles: 0,
            languages: [],
            hubFiles: [],
        },
    };
}

const FUNCTION_KINDS = new Set(['f', 'function', 'method', 'm']);
const CLASS_KINDS = new Set(['c', 'class', 'struct']);

/** Only the head of each file is scanned for imports — enough for any sane import block. */
const IMPORT_SCAN_BYTES = 64 * 1024;

/** Most common ctags language across a symbol set, or null. */
function dominantLanguage(symbols: SymbolRecord[]): string | null {
    const counts = new Map<string, number>();
    for (const s of symbols) {
        if (!s.language) continue;
        counts.set(s.language, (counts.get(s.language) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [lang, count] of counts) {
        if (count > bestCount) {
            best = lang;
            bestCount = count;
        }
    }
    return best;
}

/**
 * Analyze a workspace directory
 */
export async function analyzeWorkspace(workspacePath: string): Promise<WorkspaceAnalysis> {
    logger.info(`Analyzing workspace: ${workspacePath}`);

    if (isUnderMemoryPressure()) {
        logger.warn(`Memory pressure detected — skipping full workspace analysis`);
        return emptyAnalysis(workspacePath);
    }

    // 1. Symbol index (Universal Ctags — auto-detects every language it knows).
    let symbols: SymbolRecord[];
    try {
        symbols = (await ensureSymbolIndex(workspacePath)).symbols;
    } catch (err) {
        logger.warn(`ctags symbol index unavailable — returning minimal analysis: ${String(err)}`);
        return emptyAnalysis(workspacePath);
    }

    // 2. Detect project type from config files (framework/package-manager hints).
    const probed = await detectProjectType(workspacePath);

    // 3. Group symbols by file, apply .atlarixignore, cap for performance.
    const byFile = new Map<string, SymbolRecord[]>();
    for (const s of symbols) {
        const rel = s.path.replace(/\\/g, '/');
        if (!byFile.has(rel)) byFile.set(rel, []);
        byFile.get(rel)!.push(s);
    }
    const ig = await loadIgnorerForProject(workspacePath);
    const relPaths = [...byFile.keys()]
        .filter((rel) => !isRelPathIgnored(ig, rel))
        .sort();
    logger.info(`Found ${relPaths.length} symbol-bearing files (${byFile.size} before .atlarixignore)`);

    if (relPaths.length > WORKSPACE_LARGE_FILE_THRESHOLD) {
        logger.info(`Large workspace detected (${relPaths.length} files > ${WORKSPACE_LARGE_FILE_THRESHOLD} threshold) — limiting eager analysis`);
    }

    // 4. Per-file analysis (limit to 200 for performance)
    const analyzedFiles = await Promise.all(
        relPaths.slice(0, 200).map((rel) => analyzeFile(rel, byFile.get(rel)!, workspacePath)),
    );
    const validFiles = analyzedFiles.filter((f): f is AnalyzedFile => f !== null);

    // 5. Build dependency graph
    const dependencies = buildDependencyGraph(validFiles, workspacePath);

    // 6. Detect clusters
    const clusters = detectClusters(validFiles);

    // 7. Find entry points
    const entryPoints = findEntryPoints(validFiles);

    // 8. Find hub files (most connected)
    const hubFiles = findHubFiles(validFiles, dependencies);

    const languages = [...new Set(validFiles.map((f) => f.language).filter((l) => l !== 'unknown'))];
    const language =
        (probed.language !== 'mixed' ? probed.language : null) ??
        dominantLanguage(symbols) ??
        'mixed';

    return {
        workspacePath,
        language,
        framework: probed.framework as WorkspaceAnalysis['framework'],
        packageManager: probed.packageManager as WorkspaceAnalysis['packageManager'],
        files: validFiles,
        dependencies,
        clusters,
        entryPoints,
        metadata: {
            totalFiles: validFiles.length,
            languages,
            hubFiles,
        },
    };
}

/**
 * v12 3.2: the detectProjectType probes intentionally fall through when a
 * config file is absent (ENOENT) — but the empty catches also swallowed REAL
 * failures (malformed package.json, permission errors), silently skipping
 * detection. Log non-missing-file errors.
 */
function logProbeFailure(probe: string, e: unknown): void {
    const code = (e as { code?: string })?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return; // expected: file absent
    logger.warn(`detectProjectType: ${probe} probe failed (not ENOENT): ${String(e)}`);
}

/**
 * Detect project type from config files. Returns language 'mixed' when no
 * probe matches — the caller falls back to the dominant ctags language.
 */
async function detectProjectType(workspacePath: string): Promise<{
    language: string;
    framework?: string;
    packageManager?: string;
}> {
    // Check package.json (Node.js)
    try {
        const pkgPath = path.join(workspacePath, 'package.json');
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));

        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        // Detect framework
        let framework: string | undefined;
        if (deps.next) framework = 'next';
        else if (deps.react) framework = 'react';
        else if (deps.expo) framework = 'react';
        else if (deps['react-native']) framework = 'react';
        else if (deps.vue) framework = 'vue';
        else if (deps.express) framework = 'express';

        // Detect language (TypeScript or JavaScript)
        const language = deps.typescript ? 'typescript' : 'javascript';

        // Detect package manager
        let packageManager = 'npm';
        const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager.toLowerCase() : '';
        if (pm.startsWith('bun@')) packageManager = 'bun';
        if (await fileExists(path.join(workspacePath, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
        else if (await fileExists(path.join(workspacePath, 'yarn.lock'))) packageManager = 'yarn';
        else if (await fileExists(path.join(workspacePath, 'bun.lockb'))) packageManager = 'bun';

        return { language, framework, packageManager };
    } catch (e) { logProbeFailure('package.json', e); }

    // Check Spring Boot / Java / Kotlin (pom.xml or Gradle)
    try {
        const pomPath = path.join(workspacePath, 'pom.xml');
        const pom = await fs.readFile(pomPath, 'utf-8');
        const isSpring = /spring-boot-starter|org\\.springframework/.test(pom);
        return { language: 'java', framework: isSpring ? 'spring' : undefined, packageManager: 'maven' };
    } catch (e) { logProbeFailure('pom.xml', e); }

    try {
        const gradleKts = path.join(workspacePath, 'build.gradle.kts');
        const content = await fs.readFile(gradleKts, 'utf-8');
        const isSpring = /spring-boot|org\\.springframework/.test(content);
        return { language: 'kotlin', framework: isSpring ? 'spring' : undefined, packageManager: 'gradle' };
    } catch (e) { logProbeFailure('build.gradle.kts', e); }

    try {
        const gradle = path.join(workspacePath, 'build.gradle');
        const content = await fs.readFile(gradle, 'utf-8');
        const isSpring = /spring-boot|org\\.springframework/.test(content);
        return { language: 'java', framework: isSpring ? 'spring' : undefined, packageManager: 'gradle' };
    } catch (e) { logProbeFailure('build.gradle', e); }

    // Check pyproject.toml (Python + Poetry)
    try {
        const pyprojectPath = path.join(workspacePath, 'pyproject.toml');
        const content = await fs.readFile(pyprojectPath, 'utf-8');

        let framework: string | undefined;
        if (content.includes('fastapi')) framework = 'fastapi';
        else if (content.includes('django')) framework = 'django';
        else if (content.includes('flask')) framework = 'flask';

        return { language: 'python', framework, packageManager: 'poetry' };
    } catch (e) { logProbeFailure('pyproject.toml', e); }

    // Check requirements.txt (Python + pip)
    try {
        const reqPath = path.join(workspacePath, 'requirements.txt');
        const content = await fs.readFile(reqPath, 'utf-8');

        let framework: string | undefined;
        if (content.includes('fastapi')) framework = 'fastapi';
        else if (content.includes('django')) framework = 'django';
        else if (content.includes('flask')) framework = 'flask';

        return { language: 'python', framework, packageManager: 'pip' };
    } catch (e) { logProbeFailure('requirements.txt', e); }

    // Check Cargo.toml (Rust)
    try {
        await fs.access(path.join(workspacePath, 'Cargo.toml'));
        return { language: 'rust', packageManager: 'cargo' };
    } catch (e) { logProbeFailure('Cargo.toml', e); }

    // Check go.mod (Go)
    try {
        await fs.access(path.join(workspacePath, 'go.mod'));
        return { language: 'go', packageManager: 'go' };
    } catch (e) { logProbeFailure('go.mod', e); }

    return { language: 'mixed' };
}

/**
 * Per-file analysis: structure from the ctags symbols, imports from a
 * universal pattern pass over the head of the file.
 */
async function analyzeFile(
    relativePath: string,
    fileSymbols: SymbolRecord[],
    workspacePath: string,
): Promise<AnalyzedFile | null> {
    const absolute = path.join(workspacePath, relativePath);

    let head = '';
    try {
        const fh = await fs.open(absolute, 'r');
        try {
            const buf = Buffer.alloc(IMPORT_SCAN_BYTES);
            const { bytesRead } = await fh.read(buf, 0, IMPORT_SCAN_BYTES, 0);
            head = buf.subarray(0, bytesRead).toString('utf-8');
        } finally {
            await fh.close();
        }
    } catch {
        // Unreadable/deleted since indexing — structure from symbols still stands.
    }

    const functions = fileSymbols
        .filter((s) => FUNCTION_KINDS.has(s.kind))
        .map((s) => s.name)
        .slice(0, 20);
    const classes = fileSymbols
        .filter((s) => CLASS_KINDS.has(s.kind))
        .map((s) => s.name)
        .slice(0, 20);
    // Top-level (unscoped) symbols approximate a file's public surface.
    const exports = fileSymbols
        .filter((s) => !s.scope)
        .map((s) => s.name)
        .slice(0, 20);

    return {
        path: absolute,
        relativePath,
        language: dominantLanguage(fileSymbols) ?? 'unknown',
        type: classifyFileType(relativePath, head),
        imports: head ? extractImportsUniversal(head) : [],
        exports,
        functions,
        classes,
    };
}

/**
 * Universal import extraction — one pattern battery applied to every file
 * regardless of language. Patterns are syntax-shaped (ES import/require,
 * `import x.y`, `from x import`, `use x::y`), not language-gated, so any
 * language whose imports look like one of these contributes to the
 * dependency graph; others simply yield no edges.
 */
export function extractImportsUniversal(content: string): string[] {
    const imports: string[] = [];

    // ES `import … from '…'`
    for (const m of content.matchAll(/import\s+.*?\s+from\s+['"](.+?)['"]/g)) imports.push(m[1]);
    // CommonJS `require('…')`
    for (const m of content.matchAll(/require\(['"](.+?)['"]\)/g)) imports.push(m[1]);
    // `import x.y.z` (Python, Java, Go grouped-import lines, …)
    for (const m of content.matchAll(/^\s*import\s+([\w./]+)\s*$/gm)) imports.push(m[1]);
    // `from x.y import z` (Python)
    for (const m of content.matchAll(/^from\s+([\w.]+)\s+import/gm)) imports.push(m[1]);
    // `use x::y;` / `use X\Y;` (Rust, PHP)
    for (const m of content.matchAll(/^\s*use\s+([\w:\\]+)/gm)) imports.push(m[1]);

    return [...new Set(imports)];
}

/**
 * Classify file type based on path and content
 */
function classifyFileType(filePath: string, content: string): AnalyzedFile['type'] {
    const lowerPath = filePath.toLowerCase();
    const fileName = path.basename(lowerPath);

    if (lowerPath.includes('test') || lowerPath.includes('spec')) return 'test';
    if (lowerPath.includes('config') || fileName.includes('config')) return 'config';
    if (lowerPath.includes('model') || lowerPath.includes('schema')) return 'model';
    if (lowerPath.includes('controller') || lowerPath.includes('route')) return 'controller';
    if (lowerPath.includes('component') || content.includes('React') || content.includes('jsx')) return 'component';
    if (lowerPath.includes('service') || lowerPath.includes('handler')) return 'service';
    if (lowerPath.includes('util') || lowerPath.includes('helper')) return 'utility';

    return 'module';
}

/**
 * Build dependency graph from imports
 */
function buildDependencyGraph(files: AnalyzedFile[], _workspacePath: string): Dependency[] {
    const dependencies: Dependency[] = [];
    const fileMap = new Map<string, string>();

    // Create lookup maps
    for (const file of files) {
        fileMap.set(file.relativePath, file.relativePath);
        fileMap.set(path.basename(file.relativePath, path.extname(file.relativePath)), file.relativePath);
    }

    for (const file of files) {
        for (const imp of file.imports) {
            // Skip external packages
            if (!imp.startsWith('.') && !imp.startsWith('/') && !imp.startsWith('@/')) continue;

            // Resolve import path
            let resolved = imp.replace('@/', '').replace(/^\.\//, '').replace(/^\.\.\//, '');

            // Try to find matching file
            for (const [key, targetPath] of fileMap.entries()) {
                if (targetPath.includes(resolved) || key.includes(resolved)) {
                    dependencies.push({
                        from: file.relativePath,
                        to: targetPath,
                        type: 'import',
                    });
                    break;
                }
            }
        }
    }

    return dependencies;
}

/**
 * Detect clusters (subsystems) based on directory structure
 */
function detectClusters(files: AnalyzedFile[]): Cluster[] {
    const clusterMap = new Map<string, Set<string>>();

    for (const file of files) {
        const dir = path.dirname(file.relativePath);
        const topDir = dir.split(path.sep)[0] || 'root';

        if (!clusterMap.has(topDir)) {
            clusterMap.set(topDir, new Set());
        }
        clusterMap.get(topDir)!.add(file.relativePath);
    }

    return Array.from(clusterMap.entries())
        .filter(([_, files]) => files.size >= 2)
        .map(([name, fileSet], index) => ({
            id: `cluster_${index}`,
            name: name === 'root' ? 'Root Module' : name,
            files: Array.from(fileSet),
            purpose: inferClusterPurpose(name, Array.from(fileSet)),
            entryPoints: [],
        }));
}

/**
 * Infer cluster purpose from name and files
 */
function inferClusterPurpose(name: string, files: string[]): string {
    const lowerName = name.toLowerCase();

    if (lowerName.includes('component')) return 'UI Components';
    if (lowerName.includes('page')) return 'Application Pages';
    if (lowerName.includes('api') || lowerName.includes('route')) return 'API Endpoints';
    if (lowerName.includes('hook')) return 'React Hooks';
    if (lowerName.includes('lib') || lowerName.includes('util')) return 'Utilities';
    if (lowerName.includes('service')) return 'Business Logic';
    if (lowerName.includes('model') || lowerName.includes('db')) return 'Data Models';
    if (lowerName.includes('test')) return 'Tests';
    if (lowerName.includes('ipc')) return 'IPC Handlers';

    // Fallback: count file types
    const types = files.map(f => path.basename(f).toLowerCase());
    if (types.some(t => t.includes('component'))) return 'Components';
    if (types.some(t => t.includes('handler'))) return 'Handlers';

    return 'Module';
}

/**
 * Find likely entry points
 */
function findEntryPoints(files: AnalyzedFile[]): string[] {
    const entryNames = new Set([
        'main', 'index', 'app', 'server', 'cli', '__main__', 'manage',
    ]);

    return files
        .filter(f => {
            const baseName = path.basename(f.relativePath, path.extname(f.relativePath));
            return entryNames.has(baseName.toLowerCase());
        })
        .map(f => f.relativePath)
        .slice(0, 5);
}

/**
 * Find hub files (most imported)
 */
function findHubFiles(files: AnalyzedFile[], dependencies: Dependency[]): string[] {
    const importCounts = new Map<string, number>();

    for (const dep of dependencies) {
        const count = importCounts.get(dep.to) || 0;
        importCounts.set(dep.to, count + 1);
    }

    return Array.from(importCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([file]) => file);
}

/**
 * Utility: Check if file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}
