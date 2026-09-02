# Test Documentation

This directory contains unit tests for the Atlarix application.

## Testing Setup

We use [Vitest](https://vitest.dev/) as our testing framework, which is designed to work well with Vite and modern JavaScript.

### Test Commands

Add these commands to your `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:ui": "vitest --ui"
```

- `npm run test` - Run tests once
- `npm run test:watch` - Run tests in watch mode (rerun when files change)
- `npm run test:ui` - Run tests with UI reporter

## Mocking Guidelines

### Mocking fs module

When mocking the `node:fs` module, use a default export in the mock:

```typescript
vi.mock("node:fs", async () => {
  return {
    default: {
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      // Add other fs methods as needed
    },
  };
});
```

### Git, and why there is no JS fallback to mock

`isomorphic-git` was removed in v14.41.0. It had ever been only a lazily imported
fallback for the NETWORK flows — `gitClone` / `gitPush` / `gitSetRemoteUrl` — and
all three went with the GitHub clone dialog. Every surviving git operation shells
out through `system_git_exec`.

So there is nothing to mock for a "no git binary" path: with no fallback, a
machine without git has no git features, and the behaviour under test is the
DEGRADATION — `warnGitMissingOnce` and `GIT_NOT_INSTALLED_MESSAGE`. Mock
`isGitAvailable` to resolve `false` and assert on the message the user is shown.
See `git-missing-degradation.test.ts`.

### Testing IPC Handlers

When testing IPC handlers, mock the Electron IPC system:

```typescript
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}));
```

## Adding New Tests

1. Create a new file with the `.test.ts` or `.spec.ts` extension
2. Import the functions you want to test
3. Mock any dependencies using `vi.mock()`
4. Write your test cases using `describe()` and `it()`

## Example

See `chat_stream_handlers.test.ts` for an example of testing IPC handlers with proper mocking.
