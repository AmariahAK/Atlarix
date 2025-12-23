import type { Template } from "../../shared/templates";

/**
 * Calculates a quality score for a template based on multiple factors
 */
export function scoreTemplate(template: Template): number {
    let score = 0;

    // 1. GitHub stars (logarithmic scale to prevent skew)
    // max contribution: ~30 points for 10M+ stars
    const stars = template.stars || 0;
    score += Math.log10(stars + 1) * 10;

    // 2. Recency bonus (last commit within 6 months)
    // +20 points if recently updated
    if (template.lastUpdated) {
        const monthsSinceUpdate = getMonthsSince(new Date(template.lastUpdated));
        if (monthsSinceUpdate < 6) {
            score += 20;
        } else if (monthsSinceUpdate < 12) {
            score += 10; // Partial credit for updates within a year
        }
    }

    // 3. Has demo URL (+10 points)
    if (template.demoUrl) {
        score += 10;
    }

    // 4. Popular tech stack bonus
    // +5 points per popular technology (max 25)
    const popularStacks = ['Next.js', 'React', 'TypeScript', 'Tailwind', 'Shadcn'];
    const stackMatches = (template.techStack || []).filter(tech =>
        popularStacks.includes(tech)
    ).length;
    score += Math.min(stackMatches * 5, 25);

    // 5. Official template bonus (+15 points)
    if (template.isOfficial) {
        score += 15;
    }

    // 6. Difficulty appropriateness
    // Beginner templates are slightly preferred (easier to use)
    if (template.difficulty === 'beginner') {
        score += 5;
    } else if (template.difficulty === 'intermediate') {
        score += 3;
    }

    return score;
}

/**
 * Helper to calculate months since a date
 */
function getMonthsSince(date: Date): number {
    const now = new Date();
    const months = (now.getFullYear() - date.getFullYear()) * 12 +
        (now.getMonth() - date.getMonth());
    return months;
}

/**
 * Scores all templates and sorts by score (descending)
 */
export function rankTemplates(templates: Template[]): Template[] {
    const scored = templates.map(template => ({
        ...template,
        _score: scoreTemplate(template), // Store score for debugging
    }));

    return scored.sort((a, b) => (b._score || 0) - (a._score || 0));
}

/**
 * Deduplicates templates by GitHub URL
 */
export function deduplicateTemplates(templates: Template[]): Template[] {
    const seen = new Set<string>();
    const unique: Template[] = [];

    for (const template of templates) {
        const key = template.githubUrl || template.id;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(template);
        }
    }

    return unique;
}
