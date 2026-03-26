import {
  type Template,
  localTemplatesData,
} from "../../shared/templates";
import log from "electron-log";
import { fetchGitHubTemplates, fetchVercelExamples } from "../../lib/templates/github-source";
import { rankTemplates, deduplicateTemplates } from "../../lib/templates/scoring";
import { app } from "electron";
import path from "path";
import fs from "fs/promises";
import { searchSearxng, isSearxngEnabled } from "../../lib/search/searxng";

/**
 * Fisher-Yates shuffle for array randomization
 * Only shuffles within ranking tiers to maintain quality ordering
 */
function shuffleWithinTiers(templates: Template[]): Template[] {
  if (templates.length === 0) return templates;

  // Split into top 3 (keep order) and rest (shuffle)
  const top = templates.slice(0, 3);
  const rest = templates.slice(3);

  // Fisher-Yates shuffle for the rest
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }

  return [...top, ...rest];
}

const logger = log.scope("template_utils");

// Cache file location (lazy-loaded to avoid calling app.getPath before app is ready)
function getCacheFilePath(): string {
  return path.join(app.getPath("userData"), "templates-cache.json");
}

interface TemplateCache {
  templates: Template[];
  fetchedAt: string; // ISO timestamp
  expiresAt: string; // ISO timestamp (midnight next day)
}

let cache: TemplateCache | null = null;
let refreshScheduled = false;

/**
 * Get next midnight timestamp
 */
function getNextMidnight(): Date {
  const now = new Date();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1, // Next day
    0, 0, 0, 0 // Midnight
  );
  return midnight;
}

/**
 * Load cache from disk
 */
async function loadCacheFromDisk(): Promise<TemplateCache | null> {
  try {
    const data = await fs.readFile(getCacheFilePath(), "utf-8");
    const parsed: TemplateCache = JSON.parse(data);

    // Check if cache is still valid (hasn't expired)
    const now = new Date();
    const expiresAt = new Date(parsed.expiresAt);

    if (now < expiresAt) {
      logger.info(`Loaded valid cache from disk (expires at ${parsed.expiresAt})`);
      return parsed;
    } else {
      logger.info("Cache expired, will fetch fresh templates");
      return null;
    }
  } catch (error) {
    logger.info("No valid cache found on disk");
    return null;
  }
}

/**
 * Save cache to disk
 */
async function saveCacheToDisk(templates: Template[]): Promise<void> {
  const now = new Date();
  const midnight = getNextMidnight();

  const cacheData: TemplateCache = {
    templates,
    fetchedAt: now.toISOString(),
    expiresAt: midnight.toISOString(),
  };

  await fs.writeFile(getCacheFilePath(), JSON.stringify(cacheData, null, 2));
  logger.info(`Saved ${templates.length} templates to cache (expires at ${midnight.toISOString()})`);
}

/**
 * Search for templates via SearxNG (fallback when GitHub API fails)
 */
async function searchTemplatesViaSearxng(): Promise<Template[]> {
  if (!isSearxngEnabled()) {
    logger.info("SearxNG not enabled, skipping template search fallback");
    return [];
  }

  logger.info("Attempting SearxNG fallback for templates...");

  const templates: Template[] = [];
  const queries = [
    "react starter template github",
    "nextjs boilerplate github",
    "vite react typescript template",
    "vue starter template github",
    "express api template github",
  ];

  try {
    for (const query of queries) {
      const results = await searchSearxng(query, { engines: ['github'] }, 5);

      for (const result of results) {
        // Parse GitHub repo URL
        const match = result.url.match(/github\.com\/([^/]+)\/([^/]+)/);
        if (match) {
          const [, owner, repo] = match;
          const repoName = repo.replace(/[#?].*$/, ''); // Clean URL params

          templates.push({
            id: `${owner}/${repoName}`,
            title: result.title || repoName,
            description: result.snippet || `${owner}/${repoName}`,
            imageUrl: '', // SearxNG results don't have images
            repoOwner: owner,
            repoName: repoName,
            isOfficial: false, // These are community templates
          } as Template);
        }
      }
    }

    logger.info(`SearxNG found ${templates.length} template candidates`);
    return templates;
  } catch (error) {
    logger.error("SearxNG template search failed:", error);
    return [];
  }
}

/**
 * Fetch fresh templates from all sources
 */
async function fetchFreshTemplates(): Promise<Template[]> {
  logger.info("Fetching fresh templates from all sources...");

  let githubTemplates: Template[] = [];
  let vercelExamples: Template[] = [];
  let searxngTemplates: Template[] = [];

  try {
    // Fetch from all sources in parallel
    [githubTemplates, vercelExamples] = await Promise.all([
      fetchGitHubTemplates(),
      fetchVercelExamples(),
    ]);
  } catch (error) {
    logger.warn("GitHub/Vercel API failed, trying SearxNG fallback:", error);
    // If GitHub fails (rate limiting), try SearxNG as fallback
    searxngTemplates = await searchTemplatesViaSearxng();
  }

  // If we got very few templates from primary sources, supplement with SearxNG
  if (githubTemplates.length < 5 && isSearxngEnabled()) {
    logger.info("Few GitHub templates found, supplementing with SearxNG...");
    searxngTemplates = await searchTemplatesViaSearxng();
  }

  // Combine all sources
  const allTemplates = [
    ...localTemplatesData, // Official templates first
    ...vercelExamples,
    ...githubTemplates,
    ...searxngTemplates,
  ];

  // Deduplicate by GitHub URL
  const unique = deduplicateTemplates(allTemplates);

  // Score and rank
  const ranked = rankTemplates(unique);

  logger.info(
    `Fetched ${ranked.length} templates total (${localTemplatesData.length} local, ` +
    `${vercelExamples.length} Vercel, ${githubTemplates.length} GitHub, ${searxngTemplates.length} SearxNG)`
  );

  return ranked;
}

/**
 * Schedule midnight refresh
 */
function scheduleMidnightRefresh(): void {
  if (refreshScheduled) return;

  const midnight = getNextMidnight();
  const now = new Date();
  const msUntilMidnight = midnight.getTime() - now.getTime();

  logger.info(`Scheduling next template refresh at ${midnight.toISOString()} (in ${Math.round(msUntilMidnight / 1000 / 60)} minutes)`);

  setTimeout(async () => {
    logger.info("Midnight reached - refreshing template cache");

    try {
      const fresh = await fetchFreshTemplates();
      await saveCacheToDisk(fresh);

      // Update in-memory cache
      cache = {
        templates: fresh,
        fetchedAt: new Date().toISOString(),
        expiresAt: getNextMidnight().toISOString(),
      };

      // Schedule next refresh
      refreshScheduled = false;
      scheduleMidnightRefresh();
    } catch (error) {
      logger.error("Failed to refresh templates at midnight:", error);
    }
  }, msUntilMidnight);

  refreshScheduled = true;
}

/**
 * Get all templates with 24-hour caching
 * - Loads from disk cache if valid
 * - Fetches fresh if cache expired
 * - Schedules midnight refresh
 * - Shuffles cached results for visual variety (top 3 preserved)
 */
export async function getAllTemplates(): Promise<Template[]> {
  try {
    // Try in-memory cache first
    if (cache) {
      const expiresAt = new Date(cache.expiresAt);
      if (new Date() < expiresAt) {
        logger.info("Using in-memory cache (shuffled for variety)");
        // Shuffle on each access for visual variety
        return shuffleWithinTiers(cache.templates);
      }
    }

    // Try disk cache
    const diskCache = await loadCacheFromDisk();
    if (diskCache) {
      cache = diskCache;
      scheduleMidnightRefresh();
      logger.info("Using disk cache (shuffled for variety)");
      // Shuffle on each access for visual variety
      return shuffleWithinTiers(diskCache.templates);
    }

    // No valid cache - fetch fresh
    logger.info("No valid cache - fetching fresh templates");
    const fresh = await fetchFreshTemplates();

    // Save to disk
    await saveCacheToDisk(fresh);

    // Update in-memory cache
    cache = {
      templates: fresh,
      fetchedAt: new Date().toISOString(),
      expiresAt: getNextMidnight().toISOString(),
    };

    // Schedule midnight refresh
    scheduleMidnightRefresh();

    // Return fresh (already sorted, no shuffle needed)
    return fresh;
  } catch (error) {
    logger.error("Error getting templates:", error);
    // Ultimate fallback
    return localTemplatesData;
  }
}

export async function getTemplateOrThrow(
  templateId: string,
): Promise<Template> {
  const allTemplates = await getAllTemplates();
  const template = allTemplates.find((template) => template.id === templateId);
  if (!template) {
    throw new Error(
      `Template ${templateId} not found. Please select a different template.`,
    );
  }
  return template;
}
