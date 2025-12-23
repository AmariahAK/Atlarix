# Atlarix Troubleshooting Guide

## Common Issues & Fixes

### 1. Electron Binary Not Found (ENOENT)

**Error:**
```
spawn /path/to/Electron.app/Contents/MacOS/Electron ENOENT
```

**Cause:** Electron binary didn't download properly during `npm install`.

**Fix:**
```bash
# Remove Electron and reinstall
rm -rf node_modules/electron
npm cache clean --force
npm install

# Verify Electron binary exists
ls -la node_modules/electron/dist/Electron.app/Contents/MacOS/Electron

# Try running again
npm start
```

### 2. Node Version Warning (EBADENGINE)

**Warning:**
```
npm warn EBADENGINE Unsupported engine {
  package: 'better-sqlite3@12.4.1',
  required: { node: '20.x || 22.x || 23.x || 24.x' },
  current: { node: 'v25.2.1', npm: '11.6.4' }
}
```

**Cause:** You're using Node v25 which isn't officially supported by better-sqlite3 yet.

**Impact:** Usually harmless - the app will still work, it's just a warning.

**Fix (if needed):**
```bash
# Option 1: Use nvm to switch to Node 22 (LTS)
nvm install 22
nvm use 22
npm install

# Option 2: Ignore the warning (it still works)
# The package will build despite the warning
```

### 3. TypeScript Errors in IDE

**Error:**
```
Cannot find module 'fs' or its corresponding type declarations
Cannot find module '@ai-sdk/provider'
```

**Cause:** TypeScript can't find Node.js types or dependencies aren't fully installed.

**Fix:**
```bash
# Make sure all dependencies are installed
npm install

# The project already has @types/node in package.json
# Restart your TypeScript server in your IDE
```

### 4. Build Errors

**Error:** Various build/compile errors

**Fix:**
```bash
# Clean build and node_modules
rm -rf node_modules .vite out dist
npm install
npm start
```

### 5. Database Errors

**Error:** SQLite database issues

**Fix:**
```bash
# Remove database and let it recreate
rm -rf userData/sqlite.db
npm start
```

### 6. Port Already in Use

**Error:**
```
Error: listen EADDRINUSE: address already in use :::5173
```

**Fix:**
```bash
# Kill process on port 5173
lsof -ti:5173 | xargs kill -9

# Or use a different port
# Edit vite.renderer.config.mts and change port
```

## Testing Before UI

If you want to test the providers and tools without the full UI:

### Create a Quick Test Script

Create `test-atlarix.js` in the project root:

```javascript
// test-atlarix.js
const { OllamaProvider, LMStudioProvider, OpenRouterProvider } = require('./src/lib/providers');
const { ToolRegistry } = require('./src/lib/tools');

async function testProviders() {
  console.log('🧪 Testing Atlarix Providers...\n');

  // Test Ollama
  try {
    const ollama = new OllamaProvider(null, 'llama3.2:latest', true);
    const available = await ollama.isAvailable();
    console.log(`✓ Ollama: ${available ? '✅ Running' : '❌ Not available'}`);
    
    if (available) {
      const models = await ollama.listModels();
      console.log(`  Models: ${models.slice(0, 3).join(', ')}`);
    }
  } catch (e) {
    console.log(`✗ Ollama: ❌ Error - ${e.message}`);
  }

  // Test Tools
  console.log(`\n🛠️  Tools registered: ${ToolRegistry.getAll().length}`);
  console.log('📊 Tool stats:');
  const stats = ToolRegistry.getAll();
  console.log(`  File: ${stats.filter(t => t.category === 'file').length}`);
  console.log(`  Web: ${stats.filter(t => t.category === 'web').length}`);
  console.log(`  Execution: ${stats.filter(t => t.category === 'execution').length}`);
  console.log(`  Memory: ${stats.filter(t => t.category === 'memory').length}`);
}

testProviders().catch(console.error);
```

Then run:
```bash
node test-atlarix.js
```

## Useful Commands

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# Check if LMStudio is running
curl http://localhost:1234/v1/models

# View logs
npm start --verbose

# Type check without running
npm run ts

# Lint without running
npm run lint

# Build for production
npm run package
```

## Getting Help

1. Check this troubleshooting guide first
2. Look at the error message carefully
3. Check if providers are running (Ollama/LMStudio)
4. Try cleaning and reinstalling dependencies
5. Check the terminal output for specific errors

## Known Limitations (V1)

- Code generation tools (edit_file_section, refactor_code) - Coming in V2
- Diagram tools (get_diagram, update_diagram) - Coming in V2
- UI components (chat interface, permission dialog) - In progress
- Some tools may require permissions that aren't fully wired yet

---

**Atlarix Version:** 0.1.0  
**Status:** Alpha - Core functionality complete, UI in progress
