import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";
import { getAllTemplates } from "../utils/template_utils";
import { localTemplatesData, type Template } from "../../shared/templates";
import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const logger = log.scope("template_handlers");
const handle = createLoggedHandler(logger);

/**
 * Register IPC handlers for template operations
 */
export function registerTemplateHandlers() {
  /**
   * Get all available templates (local + API + GitHub)
   * Returns templates ranked by quality score
   */
  handle("list-templates", async (): Promise<Template[]> => {
    return await getAllTemplates();
  });

  handle("get-templates", async (): Promise<Template[]> => {
    try {
      const templates = await getAllTemplates();
      return templates;
    } catch (error) {
      logger.error("Error fetching templates:", error);
      return localTemplatesData;
    }
  });

  // Clone template
  handle("template:clone", async (event: any, options: any) => {
    const { targetDirectory, projectName, template } = options;
    const projectPath = path.join(targetDirectory, projectName);

    const sendProgress = (progress: any) => {
      event.sender.send('template:clone:progress', progress);
    };

    try {
      // Step 1: Clone
      sendProgress({ step: 'cloning', message: 'Cloning repository...', progress: 10 });
      await cloneRepository(template.repo_url, projectPath);

      // Step 2: Cleanup
      sendProgress({ step: 'cloning', message: 'Cleaning up...', progress: 30 });
      await cleanupTemplate(projectPath);

      // Step 3: Dependencies
      sendProgress({ step: 'dependencies', message: 'Installing dependencies...', progress: 50 });
      await installDependencies(projectPath);

      // Step 4: Configure
      sendProgress({ step: 'configuring', message: 'Configuring project...', progress: 80 });
      await configureProject(projectPath, projectName);

      // Step 5: Git init
      sendProgress({ step: 'configuring', message: 'Initializing git...', progress: 90 });
      await initializeGit(projectPath);

      sendProgress({ step: 'complete', message: 'Complete!', progress: 100 });

      return { success: true, projectPath };
    } catch (error: any) {
      logger.error('Template clone failed:', error);
      try {
        await fs.rm(projectPath, { recursive: true, force: true });
      } catch { }
      return { success: false, projectPath, error: error.message };
    }
  });

  // Validate directory
  handle("template:validate-directory", async (_, targetPath: string, projectName: string) => {
    const projectPath = path.join(targetPath, projectName);
    try {
      await fs.access(projectPath);
      return { valid: false, error: `Directory "${projectName}" already exists` };
    } catch { }

    try {
      await fs.access(targetPath, fs.constants.W_OK);
    } catch {
      return { valid: false, error: 'Target directory is not writable' };
    }

    return { valid: true };
  });
}

// Helper functions
async function cloneRepository(repoUrl: string, targetPath: string): Promise<void> {
  const command = `git clone --depth 1 "${repoUrl}" "${targetPath}"`;
  await execAsync(command, { maxBuffer: 1024 * 1024 * 10 });
}

async function cleanupTemplate(projectPath: string): Promise<void> {
  const filesToRemove = ['.git', '.github/FUNDING.yml', 'LICENSE'];
  for (const file of filesToRemove) {
    const filePath = path.join(projectPath, file);
    try {
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        await fs.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.unlink(filePath);
      }
    } catch { }
  }
}

async function installDependencies(projectPath: string): Promise<void> {
  const hasYarnLock = await fileExists(path.join(projectPath, 'yarn.lock'));
  const hasPnpmLock = await fileExists(path.join(projectPath, 'pnpm-lock.yaml'));
  const hasPackageJson = await fileExists(path.join(projectPath, 'package.json'));

  try {
    if (hasPackageJson) {
      let command = 'npm install';
      if (hasPnpmLock) command = 'pnpm install';
      else if (hasYarnLock) command = 'yarn install';
      await execAsync(command, { cwd: projectPath, maxBuffer: 1024 * 1024 * 50 });
    }
  } catch (error) {
    logger.warn('Dependency install warning:', error);
  }
}

async function configureProject(projectPath: string, projectName: string): Promise<void> {
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (await fileExists(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
      packageJson.name = projectName.toLowerCase().replace(/\s+/g, '-');
      packageJson.version = '0.1.0';
      delete packageJson.author;
      delete packageJson.repository;
      await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
    } catch { }
  }
}

async function initializeGit(projectPath: string): Promise<void> {
  try {
    await execAsync('git init', { cwd: projectPath });
    await execAsync('git add .', { cwd: projectPath });
    await execAsync('git commit -m "Initial commit from Atlarix"', { cwd: projectPath });
  } catch { }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
