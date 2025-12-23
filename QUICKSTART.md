# Atlarix - Quick Start Guide

Welcome to **Atlarix** - Your premium AI coding copilot! 🌌

## 🚀 Getting Started

### 1. Install Dependencies

```bash
cd /Users/amariah/Documents/GitHub/AI/Atlarix
npm install
```

### 2. Set Up Environment

```bash
# Copy example env to .env
cp .env.example .env

# Edit .env and add your API keys (optional for local providers)
```

### 3. Start Development Server

```bash
npm start
```

## 🤖 AI Provider Setup

Atlarix supports 3 AI providers:

### Option 1: Ollama (Local - Recommended)

```bash
# Install Ollama from https://ollama.ai
# Then pull a model:
ollama pull qwen2.5-coder:7b

# Ollama runs on http://localhost:11434 automatically
```

###  Option 2: LMStudio (Local)

```bash
# Download from https://lmstudio.ai
# Load a model in the UI
# Start Local Server (port 1234)
```

### Option 3: OpenRouter (Cloud)

```bash
# Get API key from https://openrouter.ai/keys
# Add to .env:
OPENROUTER_API_KEY=sk-or-v1-...
```

## ✨ Features Ready

✅ **3 AI Providers** - Ollama, LMStudio, OpenRouter  
✅ **15 Core Tools** - File ops, web search, execution, memory  
✅ **Premium Design** - Atlarix color palette & animations  
✅ **Streaming Chat** - Real-time responses  
✅ **Tool Calling** - AI can use tools automatically  
✅ **Permission System** - Preview changes before applying  

## 📝 Tool Capabilities

| Category | Tools | Count |
|----------|-------|-------|
| 📁 File Operations | read_file, write_file, write_multiple_files, get_project_structure, find_file, search_code | 6 |
| 🌐 Web | web_search, read_url, get_current_time, parse_url | 4 |
| ⚡ Execution | run_command, run_tests, ask_user | 3 |
| 🧠 Memory | recall_memory, save_learning, search_memory | 3 |

**Total: 16 tools ready for V1!**

## 🔧 Development Commands

```bash
npm start              # Start dev server
npm run lint           # Lint code
npm run ts             # Type check
npm test               # Run tests
npm run package        # Build for production
```

## 🎨 Design System

Using the Atlarix color palette:
- Background: `#0E1116` (Obsidian Graphite)
- Primary: `#4FD1C5` (Teal Glow)
- Secondary: `#A78BFA` (Soft Violet)
- Signature: Axis line animation (teal→violet gradient)

## 📚 Next Steps

1. **Test Providers**: Try connecting to Ollama/LMStudio/OpenRouter
2. **Test Tools**: Verify file reading, web search, memory work correctly
3. **Build UI**: Create chat interface using Atlarix design system
4. **Add More Tools**: Implement remaining 10-15 tools for V1
5. **Permission Dialog**: Build UI for previewing changes

## 🐛 Troubleshooting

**Ollama not connecting?**
- Check if Ollama is running: `ollama list`
- Verify host in .env: `OLLAMA_HOST=http://localhost:11434`

**LMStudio not working?**
- Make sure Local Server is started in LMStudio
- Check port: `LMSTUDIO_HOST=http://localhost:1234`

**TypeScript errors?**
- Run `npm install` to ensure all dependencies are installed
- Check `npm run ts` for type checking

---

**Built with ❤️ by NorahLabs**  
*Atlas + Axis + Intelligence*
