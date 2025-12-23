import { Sparkles, Search, Network, Wrench, Globe, Eye, Zap, MessageSquare, FileCode, Database } from "lucide-react";

export default function ToolsPage() {
    return (
        <div className="flex-1 bg-background p-8 overflow-auto">
            <div className="max-w-6xl mx-auto space-y-12">
                {/* Header */}
                <div className="text-center space-y-4">
                    <h1 className="text-5xl font-bold bg-gradient-to-r from-[#10B981] via-[#059669] to-[#F59E0B] bg-clip-text text-transparent">
                        Atlarix Tools
                    </h1>
                    <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
                        A comprehensive suite of AI-powered development tools designed to accelerate your workflow
                    </p>
                </div>

                {/* AI Capabilities Section */}
                <div className="space-y-6">
                    <h2 className="text-3xl font-bold text-foreground">🤖 AI-Powered Features</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="p-6 border border-border rounded-xl bg-card hover:border-primary/50 hover:shadow-lg transition-all">
                            <div className="flex items-start gap-4">
                                <Sparkles className="h-8 w-8 text-primary flex-shrink-0 mt-1" />
                                <div className="space-y-2">
                                    <h3 className="text-xl font-semibold text-foreground">
                                        Intelligent Code Generation
                                    </h3>
                                    <p className="text-sm text-muted-foreground leading-relaxed">
                                        Generate complete, production-ready applications from natural language descriptions.
                                        Atlarix understands context, follows best practices, and creates scalable, maintainable code
                                        across multiple frameworks including React, Next.js, Vue, and more.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 border border-border rounded-xl bg-card hover:border-primary/50 hover:shadow-lg transition-all">
                            <div className="flex items-start gap-4">
                                <MessageSquare className="h-8 w-8 text-primary flex-shrink-0 mt-1" />
                                <div className="space-y-2">
                                    <h3 className="text-xl font-semibold text-foreground">
                                        Context-Aware Chat
                                    </h3>
                                    <p className="text-sm text-muted-foreground leading-relaxed">
                                        Engage in intelligent conversations about your codebase. Ask questions, request refactoring,
                                        debug issues, or explore architectural decisions. Atlarix maintains full context of your
                                        workspace and conversation history.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 border border-border rounded-xl bg-card hover:border-primary/50 hover:shadow-lg transition-all">
                            <div className="flex items-start gap-4">
                                <FileCode className="h-8 w-8 text-primary flex-shrink-0 mt-1" />
                                <div className="space-y-2">
                                    <h3 className="text-xl font-semibold text-foreground">
                                        Smart Code Editing
                                    </h3>
                                    <p className="text-sm text-muted-foreground leading-relaxed">
                                        Request precise code modifications using natural language. Atlarix understands your intent,
                                        preserves code structure, maintains formatting, and ensures type safety while making surgical
                                        edits to your files.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 border border-border rounded-xl bg-card hover:border-primary/50 hover:shadow-lg transition-all">
                            <div className="flex items-start gap-4">
                                <Zap className="h-8 w-8 text-primary flex-shrink-0 mt-1" />
                                <div className="space-y-2">
                                    <h3 className="text-xl font-semibold text-foreground">
                                        Automated Problem Fixing
                                    </h3>
                                    <p className="text-sm text-muted-foreground leading-relaxed">
                                        Automatically detect and fix TypeScript errors, linting issues, and common bugs.
                                        Enable auto-fix mode to let Atlarix continuously improve your code quality as you work,
                                        catching issues before they become problems.
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Analysis & Insights Section */}
                <div className="space-y-6">
                    <h2 className="text-3xl font-bold text-foreground">📊 Code Analysis & Insights</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="p-6 border border-border rounded-xl bg-card hover:border-primary/50 hover:shadow-lg transition-all">
                            <div className="flex items-start gap-4">
                                <Network className="h-8 w-8 text-primary flex-shrink-0 mt-1" />
                                <div className="space-y-2">
                                    <h3 className="text-xl font-semibold text-foreground">
                                        Dependency Analysis
                                    </h3>
                                    <p className="text-sm text-muted-foreground leading-relaxed">
                                        Visualize your project's import graph, identify circular dependencies, find unused imports,
                                        and understand module coupling. Get recommendations for better code organization and
                                        improved maintainability.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 border border-border rounded-xl bg-card hover:border-primary/50 hover:shadow-lg transition-all">
                            <div className="flex items-start gap-4">
                                <Search className="h-8 w-8 text-primary flex-shrink-0 mt-1" />
                                <div className="space-y-2">
                                    <h3 className="text-xl font-semibold text-foreground">
                                        Semantic Code Search
                                    </h3>
                                    <p className="text-sm text-muted-foreground leading-relaxed">
                                        Search your codebase by intent, not just keywords. Find similar patterns, locate relevant
                                        examples, discover where specific functionality is implemented, and understand how features
                                        work across your application.
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Integration & Deployment Section */}
                <div className="space-y-6">
                    <h2 className="text-3xl font-bold text-foreground">🚀 Integration & Preview</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="p-6 border border-border rounded-xl bg-card hover:border-primary/50 hover:shadow-lg transition-all">
                            <div className="flex items-start gap-4">
                                <Globe className="h-8 w-8 text-primary flex-shrink-0 mt-1" />
                                <div className="space-y-2">
                                    <h3 className="text-xl font-semibold text-foreground">
                                        Web Search Integration
                                    </h3>
                                    <p className="text-sm text-muted-foreground leading-relaxed">
                                        Seamlessly search the web for documentation, Stack Overflow solutions, and code examples
                                        directly from your chat. Results appear in the preview panel with exact URLs and
                                        contextual snippets.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 border border-border rounded-xl bg-card hover:border-primary/50 hover:shadow-lg transition-all">
                            <div className="flex items-start gap-4">
                                <Eye className="h-8 w-8 text-primary flex-shrink-0 mt-1" />
                                <div className="space-y-2">
                                    <h3 className="text-xl font-semibold text-foreground">
                                        Live Preview & Hot Reload
                                    </h3>
                                    <p className="text-sm text-muted-foreground leading-relaxed">
                                        See your changes instantly with hot module replacement. Preview UI updates in real-time,
                                        test responsive layouts, and validate functionality without manual refreshing. Perfect for
                                        rapid iteration.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 border border-border rounded-xl bg-card hover:border-primary/50 hover:shadow-lg transition-all">
                            <div className="flex items-start gap-4">
                                <Database className="h-8 w-8 text-primary flex-shrink-0 mt-1" />
                                <div className="space-y-2">
                                    <h3 className="text-xl font-semibold text-foreground">
                                        Database Integration
                                    </h3>
                                    <p className="text-sm text-muted-foreground leading-relaxed">
                                        Connect to Supabase and Neon databases directly from Atlarix. Generate database schemas,
                                        create migrations, visualize relationships, and manage your data layer with AI assistance.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 border border-border rounded-xl bg-card hover:border-primary/50 hover:shadow-lg transition-all">
                            <div className="flex items-start gap-4">
                                <Wrench className="h-8 w-8 text-primary flex-shrink-0 mt-1" />
                                <div className="space-y-2">
                                    <h3 className="text-xl font-semibold text-foreground">
                                        Multi-Model Support
                                    </h3>
                                    <p className="text-sm text-muted-foreground leading-relaxed">
                                        Choose from 231+ OpenRouter models, run local Ollama models, or use LM Studio.
                                        Switch between Claude, GPT-4, Gemini, and other cutting-edge models to find the perfect
                                        fit for your task.
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Coming Soon */}
                <div className="mt-12 p-8 border-2 border-primary/20 rounded-2xl bg-gradient-to-br from-primary/5 to-accent/5">
                    <h3 className="text-2xl font-bold text-foreground mb-4">
                        🔮 Coming Soon
                    </h3>
                    <div className="space-y-3 text-muted-foreground">
                        <p>• <strong>Collaborative Editing:</strong> Real-time pair programming with team members</p>
                        <p>• <strong>API Testing Suite:</strong> Built-in tools for testing REST and GraphQL endpoints</p>
                        <p>• <strong>Performance Profiling:</strong> Identify bottlenecks and optimize bundle sizes</p>
                        <p>• <strong>Visual Component Builder:</strong> Drag-and-drop UI creation with code generation</p>
                        <p>• <strong>Cloud Deployment:</strong> One-click deployment to Vercel, Netlify, and AWS</p>
                    </div>
                </div>
            </div>
        </div>
    );
}
