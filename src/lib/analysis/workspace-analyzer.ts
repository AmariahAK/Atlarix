/**
 * Workspace Analyzer
 * ==================
 * Analyzes workspace structure, detects language/framework, extracts imports/exports
 * Uses Tree-sitter for accurate AST parsing, with regex fallback
 * Inspired by StackSense's diagram_builder.py
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import log from 'electron-log';
import { parseWithTreeSitter } from './treesitter-parser';

const logger = log.scope('workspace-analyzer');

// Language extension mapping (from StackSense)
const LANGUAGE_MAP: Record<string, string> = {
    '.py': 'python',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.cpp': 'cpp',
    '.c': 'c',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.dart': 'dart',
};

// Files/dirs to exclude from scanning
const EXCLUDE_PATTERNS = [
    'node_modules', '.git', '.next', 'dist', 'build', '__pycache__',
    'venv', '.venv', 'target', 'vendor', '.idea', '.vscode', 'coverage',
];

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
    language: 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'mixed';
    framework?: 'react' | 'next' | 'vue' | 'express' | 'fastapi' | 'django' | 'flask' | 'spring';
    packageManager?: 'npm' | 'yarn' | 'pnpm' | 'poetry' | 'pip' | 'cargo' | 'go';
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

/**
 * Analyze a workspace directory
 */
export async function analyzeWorkspace(workspacePath: string): Promise<WorkspaceAnalysis> {
    logger.info(`Analyzing workspace: ${workspacePath}`);

    // 1. Detect project type
    const { language, framework, packageManager } = await detectProjectType(workspacePath);
    logger.info(`Detected: ${language}${framework ? ` (${framework})` : ''}`);

    // 2. Scan files
    const filePaths = await scanFiles(workspacePath);
    logger.info(`Found ${filePaths.length} source files`);

    // 3. Analyze each file
    const analyzedFiles = await Promise.all(
        filePaths.slice(0, 200).map(f => analyzeFile(f, workspacePath))
    );
    const validFiles = analyzedFiles.filter((f): f is AnalyzedFile => f !== null);

    // 4. Build dependency graph
    const dependencies = buildDependencyGraph(validFiles, workspacePath);

    // 5. Detect clusters
    const clusters = detectClusters(validFiles);

    // 6. Find entry points
    const entryPoints = findEntryPoints(validFiles, language);

    // 7. Find hub files (most connected)
    const hubFiles = findHubFiles(validFiles, dependencies);

    // 8. Get all languages used
    const languages = [...new Set(validFiles.map(f => f.language))];

    return {
        workspacePath,
        language: language as WorkspaceAnalysis['language'],
        framework: framework as WorkspaceAnalysis['framework'],
        packageManager: packageManager as WorkspaceAnalysis['packageManager'],
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
 * Detect project type from config files
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
        else if (deps.vue) framework = 'vue';
        else if (deps.express) framework = 'express';

        // Detect language (TypeScript or JavaScript)
        const language = deps.typescript ? 'typescript' : 'javascript';

        // Detect package manager
        let packageManager = 'npm';
        if (await fileExists(path.join(workspacePath, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
        else if (await fileExists(path.join(workspacePath, 'yarn.lock'))) packageManager = 'yarn';

        return { language, framework, packageManager };
    } catch { }

    // Check pyproject.toml (Python + Poetry)
    try {
        const pyprojectPath = path.join(workspacePath, 'pyproject.toml');
        const content = await fs.readFile(pyprojectPath, 'utf-8');

        let framework: string | undefined;
        if (content.includes('fastapi')) framework = 'fastapi';
        else if (content.includes('django')) framework = 'django';
        else if (content.includes('flask')) framework = 'flask';

        return { language: 'python', framework, packageManager: 'poetry' };
    } catch { }

    // Check requirements.txt (Python + pip)
    try {
        const reqPath = path.join(workspacePath, 'requirements.txt');
        const content = await fs.readFile(reqPath, 'utf-8');

        let framework: string | undefined;
        if (content.includes('fastapi')) framework = 'fastapi';
        else if (content.includes('django')) framework = 'django';
        else if (content.includes('flask')) framework = 'flask';

        return { language: 'python', framework, packageManager: 'pip' };
    } catch { }

    // Check Cargo.toml (Rust)
    try {
        await fs.access(path.join(workspacePath, 'Cargo.toml'));
        return { language: 'rust', packageManager: 'cargo' };
    } catch { }

    // Check go.mod (Go)
    try {
        await fs.access(path.join(workspacePath, 'go.mod'));
        return { language: 'go', packageManager: 'go' };
    } catch { }

    // Fallback: count file extensions
    const files = await scanFiles(workspacePath);
    const counts: Record<string, number> = {};

    for (const file of files) {
        const ext = path.extname(file);
        const lang = LANGUAGE_MAP[ext];
        if (lang) {
            counts[lang] = (counts[lang] || 0) + 1;
        }
    }

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return { language: sorted[0]?.[0] || 'mixed' };
}

/**
 * Scan for source files recursively
 */
async function scanFiles(dir: string, relativeTo?: string): Promise<string[]> {
    const files: string[] = [];
    const base = relativeTo || dir;

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            // Skip excluded directories
            if (EXCLUDE_PATTERNS.includes(entry.name)) continue;

            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                const subFiles = await scanFiles(fullPath, base);
                files.push(...subFiles);
            } else {
                const ext = path.extname(entry.name);
                if (LANGUAGE_MAP[ext]) {
                    files.push(fullPath);
                }
            }
        }
    } catch (error) {
        logger.warn(`Error scanning ${dir}:`, error);
    }

    return files;
}

/**
 * Analyze a single file using Tree-sitter (fallback to regex)
 */
async function analyzeFile(filePath: string, workspacePath: string): Promise<AnalyzedFile | null> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const ext = path.extname(filePath);
        const language = LANGUAGE_MAP[ext] || 'unknown';
        const relativePath = path.relative(workspacePath, filePath);

        let imports: string[] = [];
        let exports: string[] = [];
        let functions: string[] = [];
        let classes: string[] = [];

        // Try tree-sitter first for accurate AST parsing
        const treeSitterResult = await parseWithTreeSitter(content, language);

        if (treeSitterResult) {
            imports = treeSitterResult.imports;
            exports = treeSitterResult.exports;
            functions = treeSitterResult.functions;
            classes = treeSitterResult.classes;
            logger.debug(`Tree-sitter parsed: ${relativePath}`);
        } else {
            // Fallback to regex parsing
            imports = extractImports(content, language);
            exports = extractExports(content, language);
            functions = extractFunctions(content, language);
            classes = extractClasses(content, language);
        }

        // Classify file type
        const type = classifyFileType(relativePath, content);

        return {
            path: filePath,
            relativePath,
            language,
            type,
            imports,
            exports,
            functions,
            classes,
        };
    } catch (error) {
        logger.warn(`Error analyzing ${filePath}:`, error);
        return null;
    }
}

/**
 * Extract imports from file content
 */
function extractImports(content: string, language: string): string[] {
    const imports: string[] = [];

    if (language === 'typescript' || language === 'javascript') {
        // ES6 imports
        const esMatches = content.matchAll(/import\s+.*?\s+from\s+['"](.+?)['"]/g);
        imports.push(...Array.from(esMatches, m => m[1]));

        // require()
        const reqMatches = content.matchAll(/require\(['"](.+?)['"]\)/g);
        imports.push(...Array.from(reqMatches, m => m[1]));
    } else if (language === 'python') {
        // import X
        const importMatches = content.matchAll(/^import\s+([\w.]+)/gm);
        imports.push(...Array.from(importMatches, m => m[1]));

        // from X import Y
        const fromMatches = content.matchAll(/^from\s+([\w.]+)\s+import/gm);
        imports.push(...Array.from(fromMatches, m => m[1]));
    } else if (language === 'go') {
        const matches = content.matchAll(/"([^"]+)"/g);
        imports.push(...Array.from(matches, m => m[1]));
    } else if (language === 'rust') {
        const matches = content.matchAll(/use\s+([\w:]+)/g);
        imports.push(...Array.from(matches, m => m[1]));
    }

    return [...new Set(imports)];
}

/**
 * Extract exports from file content
 */
function extractExports(content: string, language: string): string[] {
    const exports: string[] = [];

    if (language === 'typescript' || language === 'javascript') {
        // export function/const/class
        const matches = content.matchAll(/export\s+(?:default\s+)?(?:function|const|class|interface|type)\s+(\w+)/g);
        exports.push(...Array.from(matches, m => m[1]));
    } else if (language === 'python') {
        // __all__ = [...]
        const allMatch = content.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
        if (allMatch) {
            const names = allMatch[1].matchAll(/['"](\w+)['"]/g);
            exports.push(...Array.from(names, m => m[1]));
        }
    }

    return exports;
}

/**
 * Extract function names
 */
function extractFunctions(content: string, language: string): string[] {
    const functions: string[] = [];

    if (language === 'typescript' || language === 'javascript') {
        // function name()
        const funcMatches = content.matchAll(/function\s+(\w+)\s*\(/g);
        functions.push(...Array.from(funcMatches, m => m[1]));

        // const name = () =>
        const arrowMatches = content.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g);
        functions.push(...Array.from(arrowMatches, m => m[1]));
    } else if (language === 'python') {
        const matches = content.matchAll(/^def\s+(\w+)\s*\(/gm);
        functions.push(...Array.from(matches, m => m[1]));
    } else if (language === 'go') {
        const matches = content.matchAll(/func\s+(\w+)\s*\(/g);
        functions.push(...Array.from(matches, m => m[1]));
    } else if (language === 'rust') {
        const matches = content.matchAll(/fn\s+(\w+)\s*[(<]/g);
        functions.push(...Array.from(matches, m => m[1]));
    }

    return functions.slice(0, 20); // Limit
}

/**
 * Extract class names
 */
function extractClasses(content: string, language: string): string[] {
    const classes: string[] = [];

    if (language === 'typescript' || language === 'javascript') {
        const matches = content.matchAll(/class\s+(\w+)/g);
        classes.push(...Array.from(matches, m => m[1]));
    } else if (language === 'python') {
        const matches = content.matchAll(/^class\s+(\w+)/gm);
        classes.push(...Array.from(matches, m => m[1]));
    } else if (language === 'go') {
        const matches = content.matchAll(/type\s+(\w+)\s+struct/g);
        classes.push(...Array.from(matches, m => m[1]));
    } else if (language === 'rust') {
        const matches = content.matchAll(/struct\s+(\w+)/g);
        classes.push(...Array.from(matches, m => m[1]));
    } else if (language === 'java') {
        const matches = content.matchAll(/class\s+(\w+)/g);
        classes.push(...Array.from(matches, m => m[1]));
    }

    return classes.slice(0, 20);
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
function buildDependencyGraph(files: AnalyzedFile[], workspacePath: string): Dependency[] {
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
function findEntryPoints(files: AnalyzedFile[], language: string): string[] {
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
