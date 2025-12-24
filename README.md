# 🌌 Atlarix

**Atlas + Axis + Intelligence**

Atlarix is your premium AI coding copilot - a powerful desktop application that brings together 41 intelligent tools for modern software development. Built on lessons learned from StackSense, enhanced with ideas from leading AI coding assistants, and refined with our own innovations.

**Created by:** [NorahLabs](https://norahlabs.com)  
**Website:** [atlarix.dev](https://atlarix.dev)

---

## ✨ Features

### 🎭 Incognito Chat Mode (NEW in v0.2.0!)
- **Ephemeral Chats** - Ask anything without saving to database
- **Privacy-First** - Chats disappear when you close/leave
- **Perfect for Quick Questions** - No clutter in chat history
- **In-Memory Only** - Lightning-fast, truly private

### 🔐 OAuth Integration (NEW in v0.2.0!)
- **Sign in with Google or GitHub** - One-click authentication
- **Sidebar Login** - OAuth button just above Help
- **User Avatar Display** - See your profile and plan status
- **Sync Across Devices** - Your settings follow you

### 🎨 Aurora Color Scheme (NEW in v0.3.0!)
- **Emerald & Gold** - Vibrant teal (#10B981) and amber (#F59E0B) accents
- **Rose Highlights** - For errors and warnings (#E11D48)
- **Gradient Effects** - Teal→Gold gradients on interactive elements
- **Light & Dark Modes** - Beautiful in both themes
- **Premium Dark Cockpit** - Deep slate backgrounds with soft glows

### 🤖 Multi-Provider AI Support
- **Ollama** - Free, local models (llama3.2, codellama, qwen2.5-coder)
- **LMStudio** - Local models with beautiful GUI
- **OpenRouter** - Cloud access to 100+ models
- **Model Name Display** - See which model generated each response
- **Bring Your Own Key** - Use your preferred AI provider

### 🛠️ 41 Intelligent Tools
Atlarix integrates the complete StackSense tool suite with enhanced UI/UX:

**File Operations**
- Read, write, search, and modify files
- Multi-file operations with preview
- Smart code refactoring

**Code Intelligence**
- Semantic code search
- Architecture diagram generation
- Code analysis and suggestions

**Web & Research** (Enhanced in v0.3.0!)
- **`web_search`** - Multi-source parallel search (StackOverflow, GitHub, Reddit, MDN, DuckDuckGo)
- **`deep_search`** - Comprehensive research: search → fetch URLs → aggregate content
- **`read_url`** - Extract readable content from any webpage
- **`get_current_time`** - Current date/time with timezone
- **Source Cards** - Clickable source previews with favicons (Perplexica-style)
- **1-Hour Caching** - Fast repeated searches

**Development Tools**
- Command execution with permission system
- Template scaffolding
- Project structure analysis

**AI Memory**
- Context-aware conversations
- Project memory persistence
- Learning from your codebase

### 🔐 Unified Permission System
- Preview all changes before applying
- Syntax-highlighted code diffs  
- Single approve/reject for batched operations
- Secure command execution

---

## 🚀 Installation

### Prerequisites
- **Node.js 20+**
- **macOS / Windows / Linux**

### Development Setup

```bash
# Clone the repository
git clone https://github.com/norahlabs/atlarix.git
cd atlarix

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your API keys

# Start development server
npm start
```

### Production Build

```bash
# Build for your platform
npm run package

# Build installers
npm run make
```

---

## 🤝 AI Provider Setup

### Option 1: Ollama (Recommended for Local)

```bash
# Install Ollama from https://ollama.ai
# Then pull a model:
ollama pull llama3.2:latest

# Ollama runs on http://localhost:11434
```

### Option 2: LMStudio

```bash
# Download from https://lmstudio.ai
# Open LMStudio → Download a model
# Start Local Server (port 1234)
```

### Option 3: OpenRouter (Cloud)

```bash
# Get API key from https://openrouter.ai/keys
# Add to .env:
OPENROUTER_API_KEY=sk-or-v1-...
```

---

## 📖 Quick Start

1. **Launch Atlarix**
   ```bash
   npm start
   ```

2. **Sign in with OAuth**
   - Click "Sign in with Google" or "Sign in with GitHub"
   - Your workspace and settings sync automatically

3. **Select Provider & Model**
   - Choose your AI provider from settings
   - Pick your preferred model

4. **Start Building!**
   ```
   You: "Create a React dashboard with authentication"
   
   Atlarix: [Shows tool calls and code preview]
   
   [Approve] → Project created!
   ```

---

## 🎯 Pricing

### Free Tier
- 5 prompts per day (resets at midnight UTC)
- Full access to all 41 tools
- 1 active project at a time
- BYOK (Bring Your Own Keys)

### Pro - $19/month
- Unlimited prompts
- Unlimited projects
- Priority support
- Early access to new features

### Annual License - $149/year
- Per major version (V1, V2, V3)
- Perpetual access to purchased version
- Upgrade discounts for existing users

[View full pricing details](https://atlarix.dev/pricing)

---

## 🛠️ Development

### Project Structure

```
atlarix/
├── src/
│   ├── lib/
│   │   ├── providers/     # AI provider integrations
│   │   ├── tools/         # 41 tool implementations (from StackSense)
│   │   ├── permissions/   # Unified permission system
│   │   └── workspace/     # Context detection (no .git required)
│   ├── components/        # React components
│   ├── pages/            # App pages (AtlarixHome, AtlarixChat)
│   └── routes/           # App routing
├── assets/               # Icons, images
├── logo/                # Atlarix branding (Atlarix.png)
└── backend/             # Backend API (on Fly.io)
```

### Backend Infrastructure

- **API**: atlarix-api.fly.dev
- **Database**: PostgreSQL on Fly.io (atlarix-db)
- **OAuth**: Google & GitHub authentication
- **Payments**: Lemon Squeezy integration

### Run Tests

```bash
npm test               # Run all tests
npm run test:watch     # Watch mode
npm run test:ui        # UI testing
```

### Code Quality

```bash
npm run lint          # Lint code
npm run prettier      # Format code
npm run ts            # Type check
```

---

## 🎨 Design Philosophy

**Atlarix** = Atlas (grounded) + Axis (directional) + Intelligence (luminous)

The UI embodies "dark cockpit + soft glow":
- **Reduced eye fatigue** with deep blacks
- **Intelligent highlights** in teal & violet
- **Premium feel** without loudness
- **Axis line signature** - subtle visual identity

Typography:
- **Geist** for UI text
- **Geist Mono** for code

---

## 🏗️ Built With

Atlarix was developed as an evolution of the [StackSense](https://github.com/norahlabs/stacksense) CLI tool, bringing its 41 powerful tools to a beautiful desktop interface. The UI/UX draws inspiration from best practices in modern development tools while maintaining its own unique identity.

**Core Technologies:**
- Electron for cross-platform desktop
- React 19 + TypeScript
- TailwindCSS for styling
- Jotai for state management
- PostgreSQL for data persistence

---

## 📜 License

PROPRIETARY - All Rights Reserved. See [LICENSE](./LICENSE) for details.

Copyright © 2024-2025 NorahLabs.

This software may not be published, distributed, modified, or used commercially without explicit written permission.

---

## 🆘 Support

- **Website:** [https://atlarix.dev](https://atlarix.dev)
- **Company:** [https://norahlabs.com](https://norahlabs.com)
- **Issues:** [GitHub Issues](https://github.com/norahlabs/atlarix/issues)
- **Email:** support@norahlabs.com

---

**Built with ❤️ by NorahLabs**
# Atlarix
