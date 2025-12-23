# Testing Atlarix Locally

## Quick Start

1. **Install dependencies:**
```bash
npm install
```

2. **Start the development server:**
```bash
npm run dev
```

3. **Access Atlarix Chat:**
Navigate to: `http://localhost:3000/atlarix-chat` (or wherever your dev server runs)

## Required Environment Variables

Create `.env.local` file:

```bash
# OpenRouter API Key (for AI)
NEXT_PUBLIC_OPENROUTER_API_KEY=your_key_here

# Or use local models
NEXT_PUBLIC_OLLAMA_URL=http://localhost:11434

# Optional: Backend API
NEXT_PUBLIC_API_URL=https://atlarix-api.fly.dev
```

## What's Integrated

✅ **41 Tools** - All fully functional
✅ **UI Components** - Title bar, sidebar, chat, input
✅ **AI Providers** - OpenRouter, Ollama, LMStudio
✅ **Tool Execution** - Real-time tool calls with visualization
✅ **File Attachments** - @ mentions and file uploads
✅ **Diagrams** - Mermaid.js rendering
✅ **Web Search** - DuckDuckGo integration
✅ **Code Preview** - Syntax highlighting

## Test Commands

Try these in the chat:

1. **"Analyze this codebase"** - Uses semantic_search + analyze_context
2. **"Generate a Next.js app"** - Uses generate_from_template
3. **"Show me the architecture diagram"** - Uses get_diagram
4. **"Search web for React best practices"** - Uses web_search
5. **"Run tests"** - Uses test_changes

## Keyboard Shortcuts

- `Enter` - Send message
- `Shift+Enter` - New line
- `@` - Attach file

## Troubleshooting

**No AI response?**
- Check OpenRouter API key
- Or start Ollama: `ollama serve`

**Tools not working?**
- Tools execute automatically when AI decides to use them
- Check browser console for errors

**Blank screen?**
- Check `/atlarix-chat` route exists
- Verify all components imported correctly
