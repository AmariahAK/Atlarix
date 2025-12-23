/**
 * Template Browser Component
 * ============================
 * Browse and select project templates
 */

import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TemplateService, Template } from '@/lib/templates/template-service';
import { Search, Star, ExternalLink, Loader2 } from 'lucide-react';

interface TemplateBrowserProps {
    onSelectTemplate: (template: Template) => void;
}

export function TemplateBrowser({ onSelectTemplate }: TemplateBrowserProps) {
    const [templates, setTemplates] = useState<Template[]>([]);
    const [filteredTemplates, setFilteredTemplates] = useState<Template[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<Template['category'] | 'all'>('all');
    const [selectedDifficulty, setSelectedDifficulty] = useState<Template['difficulty'] | 'all'>('all');

    const templateService = TemplateService.getInstance();

    useEffect(() => {
        loadTemplates();
    }, []);

    useEffect(() => {
        applyFilters();
    }, [templates, searchQuery, selectedCategory, selectedDifficulty]);

    const loadTemplates = async () => {
        try {
            setLoading(true);
            const data = await templateService.getTemplates();
            setTemplates(data);
        } catch (error) {
            console.error('Failed to load templates:', error);
        } finally {
            setLoading(false);
        }
    };

    const applyFilters = () => {
        let filtered = templates;

        // Search filter
        if (searchQuery) {
            filtered = templateService.search(searchQuery);
        }

        // Category filter
        if (selectedCategory !== 'all') {
            filtered = filtered.filter((t) => t.category === selectedCategory);
        }

        // Difficulty filter
        if (selectedDifficulty !== 'all') {
            filtered = filtered.filter((t) => t.difficulty === selectedDifficulty);
        }

        setFilteredTemplates(filtered);
    };

    const categories: Array<{ value: Template['category'] | 'all'; label: string }> = [
        { value: 'all', label: 'All' },
        { value: 'frontend', label: 'Frontend' },
        { value: 'backend', label: 'Backend' },
        { value: 'fullstack', label: 'Full Stack' },
        { value: 'mobile', label: 'Mobile' },
        { value: 'api', label: 'API' },
        { value: 'cli', label: 'CLI' },
    ];

    const difficulties: Array<{ value: Template['difficulty'] | 'all'; label: string }> = [
        { value: 'all', label: 'All Levels' },
        { value: 'beginner', label: 'Beginner' },
        { value: 'intermediate', label: 'Intermediate' },
        { value: 'advanced', label: 'Advanced' },
    ];

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="text-center space-y-2">
                <h2 className="text-3xl font-bold">Browse Templates</h2>
                <p className="text-muted-foreground">
                    Choose from {templates.length} high-quality project templates
                </p>
            </div>

            {/* Filters */}
            <div className="space-y-4">
                {/* Search */}
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        type="text"
                        placeholder="Search templates..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                    />
                </div>

                {/* Category Filters */}
                <div className="flex flex-wrap gap-2">
                    {categories.map((cat) => (
                        <Button
                            key={cat.value}
                            onClick={() => setSelectedCategory(cat.value)}
                            variant={selectedCategory === cat.value ? 'default' : 'outline'}
                            size="sm"
                            className={
                                selectedCategory === cat.value
                                    ? 'bg-primary text-primary-foreground'
                                    : 'hover:bg-accent'
                            }
                        >
                            {cat.label}
                        </Button>
                    ))}
                </div>

                {/* Difficulty Filters */}
                <div className="flex gap-2">
                    {difficulties.map((diff) => (
                        <Button
                            key={diff.value}
                            onClick={() => setSelectedDifficulty(diff.value)}
                            variant={selectedDifficulty === diff.value ? 'secondary' : 'ghost'}
                            size="sm"
                        >
                            {diff.label}
                        </Button>
                    ))}
                </div>
            </div>

            {/* Results Count */}
            <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                    {filteredTemplates.length} {filteredTemplates.length === 1 ? 'template' : 'templates'}{' '}
                    found
                </span>
                <Button onClick={loadTemplates} variant="ghost" size="sm" disabled={loading}>
                    {loading ? (
                        <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Loading...
                        </>
                    ) : (
                        'Refresh'
                    )}
                </Button>
            </div>

            {/* Templates Grid */}
            {loading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {[...Array(6)].map((_, i) => (
                        <Card key={i} className="animate-pulse">
                            <CardHeader>
                                <div className="h-6 bg-border rounded w-3/4" />
                                <div className="h-4 bg-border rounded w-full mt-2" />
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-2">
                                    <div className="h-4 bg-border rounded w-1/2" />
                                    <div className="h-4 bg-border rounded w-2/3" />
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            ) : filteredTemplates.length === 0 ? (
                <div className="text-center py-12">
                    <p className="text-muted-foreground">No templates found matching your criteria</p>
                    <Button
                        onClick={() => {
                            setSearchQuery('');
                            setSelectedCategory('all');
                            setSelectedDifficulty('all');
                        }}
                        variant="outline"
                        className="mt-4"
                    >
                        Clear Filters
                    </Button>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredTemplates.map((template) => (
                        <Card
                            key={template.id}
                            className="hover:border-primary transition-all cursor-pointer group"
                            onClick={() => onSelectTemplate(template)}
                        >
                            <CardHeader>
                                <CardTitle className="flex items-start justify-between gap-2">
                                    <span className="group-hover:text-primary transition-colors">
                                        {template.name}
                                    </span>
                                    {template.demo_url && (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-6 w-6"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                window.open(template.demo_url, '_blank');
                                            }}
                                        >
                                            <ExternalLink className="h-4 w-4" />
                                        </Button>
                                    )}
                                </CardTitle>
                                <CardDescription className="line-clamp-2">{template.description}</CardDescription>
                            </CardHeader>

                            <CardContent className="space-y-4">
                                {/* Tech Stack */}
                                <div className="flex flex-wrap gap-1">
                                    {template.tech_stack.slice(0, 4).map((tech) => (
                                        <Badge key={tech} variant="secondary" className="text-xs">
                                            {tech}
                                        </Badge>
                                    ))}
                                    {template.tech_stack.length > 4 && (
                                        <Badge variant="secondary" className="text-xs">
                                            +{template.tech_stack.length - 4}
                                        </Badge>
                                    )}
                                </div>

                                {/* Metadata */}
                                <div className="flex items-center justify-between text-xs text-muted-foreground">
                                    <div className="flex items-center gap-1">
                                        <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                                        <span>{template.stars.toLocaleString()}</span>
                                    </div>
                                    <Badge
                                        variant={
                                            template.difficulty === 'beginner'
                                                ? 'default'
                                                : template.difficulty === 'intermediate'
                                                    ? 'secondary'
                                                    : 'outline'
                                        }
                                        className="text-xs"
                                    >
                                        {template.difficulty}
                                    </Badge>
                                </div>

                                {/* Use Button */}
                                <Button className="w-full atlarix-glow" size="sm">
                                    Use This Template
                                </Button>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}
