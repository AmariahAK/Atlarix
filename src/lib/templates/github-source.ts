import {
    type Template,
    localTemplatesData,
} from "../../shared/templates";
import log from "electron-log";

const logger = log.scope("github_template_source");

// GitHub API base URL
const GITHUB_API = "https://api.github.com";

function githubAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  const token = (process.env.TEMPLATE_TOKEN ?? "").trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// Search queries for different template types
const TEMPLATE_QUERIES = [
    "nextjs template stars:>100",
    "react vite template stars:>200",
    "typescript template stars:>150",
    "topic:nextjs-template stars:>50",
    "topic:react-template stars:>50",
    "topic:vite-template stars:>30",
    "topic:starter-template stars:>100",
    // Backend
    "fastapi template stars:>100",
    "express typescript template stars:>100",
    // Fullstack
    "t3-stack stars:>100",
    "remix template stars:>100",
];

/**
 * Fetch templates from GitHub API
 * Uses multiple search queries to get diverse results
 */
export async function fetchGitHubTemplates(): Promise<Template[]> {
    try {
        logger.info("Fetching templates from GitHub API...");

        // Fetch from more queries for better coverage (6 queries, 20 results each = ~120 templates before dedup)
        const results = await Promise.all(
            TEMPLATE_QUERIES.slice(0, 6).map(query => searchGitHub(query, 20))
        );

        // Flatten and deduplicate
        const allTemplates = results.flat();
        const uniqueTemplates = deduplicateByUrl(allTemplates);

        logger.info(`Fetched ${uniqueTemplates.length} unique templates from GitHub`);
        return uniqueTemplates;
    } catch (error) {
        logger.error("Failed to fetch GitHub templates:", error);
        return [];
    }
}

/**
 * Search GitHub repositories
 */
async function searchGitHub(query: string, perPage: number = 30): Promise<Template[]> {
    try {
        const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`;

        const response = await fetch(url, {
            headers: githubAuthHeaders(),
        });

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        return data.items.map((item: any) => convertGitHubRepoToTemplate(item));
    } catch (error) {
        logger.error(`Failed to search GitHub for "${query}":`, error);
        return [];
    }
}

/**
 * Fetch Vercel Next.js examples
 * These are official, high-quality templates
 */
export async function fetchVercelExamples(): Promise<Template[]> {
    try {
        logger.info("Fetching Vercel Next.js examples...");

        const url = `${GITHUB_API}/repos/vercel/next.js/contents/examples`;
        const response = await fetch(url, {
            headers: githubAuthHeaders(),
        });

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status}`);
        }

        const examples = await response.json();

        // Filter directories only and convert to templates
        const templates = examples
            .filter((item: any) => item.type === 'dir')
            .slice(0, 50) // More Vercel examples for better coverage
            .map((item: any) => ({
                id: `vercel-${item.name}`,
                title: formatExampleName(item.name),
                description: `Next.js official example: ${item.name}`,
                // GitHub OpenGraph endpoint is rate-limited (429). Use org avatar instead.
                imageUrl: `https://github.com/vercel.png?size=200`,
                githubUrl: `https://github.com/vercel/next.js/tree/canary/examples/${item.name}`,
                category: 'fullstack' as const,
                techStack: ['Next.js', 'React', 'TypeScript'],
                difficulty: 'intermediate' as const,
                isOfficial: true,
                stars: 0, // We don't have individual stars for examples
            }));

        logger.info(`Fetched ${templates.length} Vercel examples`);
        return templates;
    } catch (error) {
        logger.error("Failed to fetch Vercel examples:", error);
        return [];
    }
}

/**
 * Convert GitHub repository to Template format
 */
function convertGitHubRepoToTemplate(repo: any): Template {
    // Extract owner/repo from full_name
    const [owner, name] = repo.full_name.split('/');

    // Determine category from topics/language
    const category = determineCategory(repo.topics || [], repo.language);

    // Extract tech stack from topics
    const techStack = extractTechStack(repo.topics || [], repo.language);

    // Determine difficulty from stars
    const difficulty = determineDifficulty(repo.stargazers_count);

    return {
        id: repo.full_name,
        title: repo.name,
        description: repo.description || 'No description available',
        // GitHub OpenGraph endpoint is rate-limited (429). Use owner avatar instead.
        imageUrl: `https://github.com/${owner}.png?size=200`,
        githubUrl: repo.html_url,
        category,
        techStack,
        difficulty,
        stars: repo.stargazers_count,
        lastUpdated: repo.updated_at,
        isOfficial: false,
    };
}

/**
 * Determine template category from topics and language
 */
function determineCategory(topics: string[], language: string): Template['category'] {
    const topicsLower = topics.map(t => t.toLowerCase()).join(' ');

    if (topicsLower.includes('fullstack') || topicsLower.includes('full-stack')) {
        return 'fullstack';
    }
    if (topicsLower.includes('backend') || topicsLower.includes('api')) {
        return 'backend';
    }
    if (topicsLower.includes('mobile') || topicsLower.includes('ios') || topicsLower.includes('android')) {
        return 'mobile';
    }
    if (topicsLower.includes('cli')) {
        return 'cli';
    }

    // Default based on language
    if (['JavaScript', 'TypeScript', 'Vue', 'Svelte'].includes(language)) {
        return 'frontend';
    }
    if (['Python', 'Go', 'Rust', 'Java'].includes(language)) {
        return 'backend';
    }

    return 'frontend'; // Default
}

/**
 * Extract tech stack from topics and language
 */
function extractTechStack(topics: string[], language: string): string[] {
    const stack: string[] = [];

    // Add language
    if (language) {
        stack.push(language);
    }

    // Add popular frameworks from topics
    const frameworks = [
        'nextjs', 'react', 'vue', 'svelte', 'angular',
        'tailwind', 'tailwindcss', 'typescript',
        'fastapi', 'express', 'nest', 'django', 'flask'
    ];

    topics.forEach(topic => {
        const lower = topic.toLowerCase();
        if (frameworks.some(fw => lower.includes(fw))) {
            // Capitalize first letter
            stack.push(topic.charAt(0).toUpperCase() + topic.slice(1));
        }
    });

    return stack.slice(0, 5); // Limit to 5
}

/**
 * Determine difficulty based on stars
 */
function determineDifficulty(stars: number): Template['difficulty'] {
    if (stars > 5000) return 'advanced';
    if (stars > 1000) return 'intermediate';
    return 'beginner';
}

/**
 * Format example name (e.g., "api-routes-cors" -> "API Routes CORS")
 */
function formatExampleName(name: string): string {
    return name
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Deduplicate templates by GitHub URL
 */
function deduplicateByUrl(templates: Template[]): Template[] {
    const seen = new Set<string>();
    return templates.filter(template => {
        if (!template.githubUrl) return true;
        if (seen.has(template.githubUrl)) return false;
        seen.add(template.githubUrl);
        return true;
    });
}

// ===== FUTURE SOURCES (Commented out for V1) =====

/*
// NPM Create Tools
async function fetchNPMTemplates(): Promise<Template[]> {
  const createTools = [
    'create-next-app',
    'create-react-app',
    'create-vue',
    'create-vite',
    'create-remix',
    'create-astro',
    'create-t3-app',
  ];
  
  // Search NPM registry for each tool
  const results = await Promise.all(
    createTools.map(tool => 
      fetch(`https://registry.npmjs.org/-/v1/search?text=${tool}&size=1`)
        .then(r => r.json())
    )
  );
  
  return results
    .flatMap(r => r.objects)
    .map(obj => ({
      id: obj.package.name,
      title: obj.package.name,
      description: obj.package.description,
      imageUrl: '',
      githubUrl: obj.package.links.repository,
      category: 'fullstack',
      techStack: obj.package.keywords || [],
      isOfficial: true,
    }));
}

// Awesome Lists
async function fetchAwesomeListTemplates(list: string): Promise<Template[]> {
  const url = `https://raw.githubusercontent.com/${list}/main/README.md`;
  const markdown = await fetch(url).then(r => r.text());
  
  // Extract GitHub URLs
  const repoRegex = /https:\/\/github\.com\/([\w-]+)\/([\w-]+)/g;
  const repos = [...markdown.matchAll(repoRegex)];
  
  // Filter for templates
  return repos
    .filter(([url]) => 
      url.includes('template') || 
      url.includes('starter') ||
      url.includes('boilerplate')
    )
    .map(([url, owner, repo]) => ({
      id: `${owner}/${repo}`,
      title: repo,
      description: '',
      // GitHub OpenGraph endpoint is rate-limited (429). Use owner avatar instead.
      imageUrl: `https://github.com/${owner}.png?size=200`,
      githubUrl: url,
      category: 'frontend',
      techStack: [],
      isOfficial: false,
    }));
}
*/
