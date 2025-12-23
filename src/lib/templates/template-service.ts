/**
 * Template Service
 * =================
 * Aggregates templates from multiple sources (GitHub, Vercel, curated list)
 */

export interface Template {
    id: string;
    name: string;
    description: string;
    category: 'frontend' | 'backend' | 'fullstack' | 'mobile' | 'api' | 'cli';
    tech_stack: string[];
    features: string[];
    repo_url: string;
    demo_url?: string;
    thumbnail?: string;
    difficulty: 'beginner' | 'intermediate' | 'advanced';
    stars: number;
    last_commit?: string;
    score: number;
}

export class TemplateService {
    private static instance: TemplateService;
    private templates: Template[] = [];
    private lastFetched: Date | null = null;
    private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

    private constructor() { }

    static getInstance(): TemplateService {
        if (!TemplateService.instance) {
            TemplateService.instance = new TemplateService();
        }
        return TemplateService.instance;
    }

    /**
     * Get all templates (from cache or fetch fresh)
     */
    async getTemplates(forceRefresh = false): Promise<Template[]> {
        const now = new Date();
        const needsRefresh =
            forceRefresh ||
            !this.lastFetched ||
            now.getTime() - this.lastFetched.getTime() > this.CACHE_DURATION;

        if (needsRefresh) {
            await this.fetchTemplates();
        }

        return this.templates;
    }

    /**
     * Fetch templates from all sources
     */
    private async fetchTemplates(): Promise<void> {
        try {
            const [githubTemplates, vercelTemplates, curatedTemplates] = await Promise.all([
                this.fetchGitHubTemplates(),
                this.fetchVercelTemplates(),
                this.fetchCuratedTemplates(),
            ]);

            // Merge and deduplicate
            const allTemplates = [...githubTemplates, ...vercelTemplates, ...curatedTemplates];
            this.templates = this.deduplicateTemplates(allTemplates);

            // Score and sort
            this.templates = this.scoreAndSortTemplates(this.templates);

            this.lastFetched = new Date();
        } catch (error) {
            console.error('Failed to fetch templates:', error);
            // Fall back to curated templates only
            this.templates = await this.fetchCuratedTemplates();
        }
    }

    /**
     * Fetch templates from GitHub trending/popular repos
     */
    private async fetchGitHubTemplates(): Promise<Template[]> {
        try {
            // Search for template/starter/boilerplate repos
            const queries = [
                'template language:typescript stars:>100',
                'starter language:javascript stars:>100',
                'boilerplate stars:>100',
            ];

            const templates: Template[] = [];

            for (const query of queries) {
                const response = await fetch(
                    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=20`,
                    {
                        headers: {
                            Accept: 'application/vnd.github.v3+json',
                        },
                    }
                );

                if (response.ok) {
                    const data = await response.json();
                    const repos = data.items || [];

                    for (const repo of repos) {
                        if (this.isValidTemplate(repo)) {
                            templates.push(this.normalizeGitHubTemplate(repo));
                        }
                    }
                }
            }

            return templates;
        } catch (error) {
            console.error('GitHub template fetch failed:', error);
            return [];
        }
    }

    /**
     * Fetch templates from Vercel
     */
    private async fetchVercelTemplates(): Promise<Template[]> {
        try {
            // Vercel's template marketplace (example - adjust URL based on actual API)
            const templates: Template[] = [
                // Hardcoded popular Vercel templates until we find public API
                {
                    id: 'nextjs-saas',
                    name: 'Next.js SaaS Starter',
                    description: 'Full-stack SaaS template with auth and payments',
                    category: 'fullstack',
                    tech_stack: ['Next.js', 'TypeScript', 'Tailwind', 'Prisma', 'Stripe'],
                    features: ['Authentication', 'Payments', 'Dashboard'],
                    repo_url: 'https://github.com/vercel/nextjs-subscription-payments',
                    demo_url: 'https://subscription-payments.vercel.app/',
                    difficulty: 'intermediate',
                    stars: 5000,
                    score: 0,
                },
                {
                    id: 'nextjs-blog',
                    name: 'Next.js Blog',
                    description: 'Modern blog with MDX support',
                    category: 'frontend',
                    tech_stack: ['Next.js', 'TypeScript', 'Tailwind', 'MDX'],
                    features: ['Blog', 'SEO', 'RSS'],
                    repo_url: 'https://github.com/vercel/next.js/tree/canary/examples/blog',
                    demo_url: 'https://next-blog-starter.vercel.app/',
                    difficulty: 'beginner',
                    stars: 3000,
                    score: 0,
                },
            ];

            return templates;
        } catch (error) {
            console.error('Vercel template fetch failed:', error);
            return [];
        }
    }

    /**
     * Fetch curated templates (manually maintained list)
     */
    private async fetchCuratedTemplates(): Promise<Template[]> {
        // These are high-quality, battle-tested templates
        return [
            {
                id: 't3-stack',
                name: 'T3 Stack',
                description: 'Type-safe full-stack starter with Next.js, tRPC, and Prisma',
                category: 'fullstack',
                tech_stack: ['Next.js', 'TypeScript', 'tRPC', 'Prisma', 'Tailwind'],
                features: ['Type Safety', 'API', 'Database', 'Authentication'],
                repo_url: 'https://github.com/t3-oss/create-t3-app',
                demo_url: 'https://create.t3.gg/',
                difficulty: 'intermediate',
                stars: 20000,
                score: 0,
            },
            {
                id: 'fastapi-template',
                name: 'FastAPI + PostgreSQL',
                description: 'Production-ready FastAPI backend with PostgreSQL',
                category: 'backend',
                tech_stack: ['Python', 'FastAPI', 'PostgreSQL', 'SQLAlchemy', 'Docker'],
                features: ['REST API', 'Auth', 'OpenAPI Docs', 'Docker'],
                repo_url: 'https://github.com/tiangolo/full-stack-fastapi-postgresql',
                difficulty: 'intermediate',
                stars: 15000,
                score: 0,
            },
            {
                id: 'react-dashboard',
                name: 'React Admin Dashboard',
                description: 'Feature-rich admin panel with charts and tables',
                category: 'frontend',
                tech_stack: ['React', 'TypeScript', 'Recharts', 'TanStack Table'],
                features: ['Charts', 'Tables', 'Dark Mode'],
                repo_url: 'https://github.com/horizon-ui/horizon-ui-chakra',
                difficulty: 'beginner',
                stars: 8000,
                score: 0,
            },
            {
                id: 'expo-starter',
                name: 'Expo React Native Starter',
                description: 'Cross-platform mobile app starter',
                category: 'mobile',
                tech_stack: ['React Native', 'Expo', 'TypeScript', 'NativeWind'],
                features: ['Navigation', 'Authentication', 'Dark Mode'],
                repo_url: 'https://github.com/obytes/react-native-template-obytes',
                difficulty: 'intermediate',
                stars: 5000,
                score: 0,
            },
        ];
    }

    /**
     * Check if repo is a valid template
     */
    private isValidTemplate(repo: any): boolean {
        const keywords = ['template', 'starter', 'boilerplate'];
        const nameMatch = keywords.some((k) => repo.name.toLowerCase().includes(k));
        const descMatch = keywords.some((k) => repo.description?.toLowerCase().includes(k));

        return (nameMatch || descMatch) && repo.stargazers_count > 100;
    }

    /**
     * Normalize GitHub repo to Template format
     */
    private normalizeGitHubTemplate(repo: any): Template {
        // Extract tech stack from topics
        const techStack = repo.topics?.slice(0, 5) || [];

        return {
            id: repo.full_name.replace('/', '-'),
            name: repo.name,
            description: repo.description || 'No description',
            category: this.categorizeTemplate(repo),
            tech_stack: techStack,
            features: [],
            repo_url: repo.html_url,
            difficulty: 'intermediate',
            stars: repo.stargazers_count,
            last_commit: repo.updated_at,
            score: 0,
        };
    }

    /**
     * Categorize template based on name/description
     */
    private categorizeTemplate(repo: any): Template['category'] {
        const text = `${repo.name} ${repo.description}`.toLowerCase();

        if (text.includes('react-native') || text.includes('expo') || text.includes('flutter')) {
            return 'mobile';
        }
        if (text.includes('api') || text.includes('fastapi') || text.includes('express')) {
            return 'api';
        }
        if (text.includes('cli') || text.includes('command')) {
            return 'cli';
        }
        if (text.includes('backend') || text.includes('server')) {
            return 'backend';
        }
        if (text.includes('fullstack') || text.includes('full-stack')) {
            return 'fullstack';
        }
        return 'frontend';
    }

    /**
     * Remove duplicate templates (same repo URL)
     */
    private deduplicateTemplates(templates: Template[]): Template[] {
        const seen = new Set<string>();
        return templates.filter((template) => {
            if (seen.has(template.repo_url)) {
                return false;
            }
            seen.add(template.repo_url);
            return true;
        });
    }

    /**
     * Score templates based on quality signals
     */
    private scoreAndSortTemplates(templates: Template[]): Template[] {
        return templates
            .map((template) => ({
                ...template,
                score: this.calculateScore(template),
            }))
            .sort((a, b) => b.score - a.score);
    }

    /**
     * Calculate quality score for a template
     */
    private calculateScore(template: Template): number {
        let score = 0;

        // GitHub stars (normalized, logarithmic)
        score += Math.log10(template.stars + 1) * 10;

        // Recency (last commit within 6 months)
        if (template.last_commit) {
            const daysSinceUpdate =
                (Date.now() - new Date(template.last_commit).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceUpdate < 180) score += 20;
        }

        // Has demo URL
        if (template.demo_url) score += 10;

        // Popular tech stack
        const popularStacks = ['Next.js', 'React', 'TypeScript', 'Tailwind', 'FastAPI'];
        const stackScore = template.tech_stack.filter((t) => popularStacks.includes(t)).length * 5;
        score += stackScore;

        // Difficulty (beginners prefer easier templates)
        if (template.difficulty === 'beginner') score += 15;
        else if (template.difficulty === 'intermediate') score += 10;

        return score;
    }

    /**
     * Search templates by query
     */
    search(query: string): Template[] {
        const lowerQuery = query.toLowerCase();
        return this.templates.filter(
            (t) =>
                t.name.toLowerCase().includes(lowerQuery) ||
                t.description.toLowerCase().includes(lowerQuery) ||
                t.tech_stack.some((tech) => tech.toLowerCase().includes(lowerQuery))
        );
    }

    /**
     * Filter templates by category
     */
    filterByCategory(category: Template['category']): Template[] {
        return this.templates.filter((t) => t.category === category);
    }

    /**
     * Filter templates by tech stack
     */
    filterByTech(tech: string): Template[] {
        return this.templates.filter((t) =>
            t.tech_stack.some((t) => t.toLowerCase().includes(tech.toLowerCase()))
        );
    }
}
