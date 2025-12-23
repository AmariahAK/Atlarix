# Contributing to Atlarix

Thank you for your interest in Atlarix!

## ⚠️ IMPORTANT: Proprietary Software Notice

**Atlarix is proprietary software. All rights reserved.**

While the source code may be viewable, this software is NOT open source. You may NOT:
- Publish or redistribute this software
- Create derivative works
- Use this software commercially
- Modify the source code for redistribution

For licensing inquiries, please contact: amariah@norahlabs.com

---

## 🐛 Reporting Bugs

If you find a bug, please open an issue on GitHub with:
- Steps to reproduce
- Expected behavior
- Actual behavior  
- Screenshots (if applicable)
- System information (OS, Node version, etc.)

---

## 💡 Suggesting Features

We welcome feature suggestions! Please open an issue with:
- Clear description of the feature
- Use case / benefit
- Any relevant examples or mockups

---

## 📖 Documentation Improvements

Found a typo or unclear documentation? Please open a PR with improvements!

Documentation locations:
- `/README.md` - Main documentation
- `/docs/` - Additional guides
- Inline code comments

---

## 🔧 Development Guidelines

If you've been granted permission to contribute code:

### Setup

```bash
# Clone the repository
git clone https://github.com/norahlabs/atlarix.git
cd atlarix

# Install dependencies
npm install

# Start development server
npm start
```

### Code Quality

```bash
# Run linter
npm run lint

# Format code
npm run prettier

# Type check
npm run ts

# Run tests
npm test
```

### Commit Messages

Use conventional commits:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting)
- `refactor:` - Code refactoring
- `test:` - Test additions/changes
- `chore:` - Maintenance tasks

Example: `feat: add support for Claude 3.5 Sonnet`

---

## 📝 Pull Request Process

1. Fork the repository (if permitted)
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests and linting
5. Commit with conventional commit message
6. Push to your branch
7. Open a Pull Request

---

## 🆘 Questions?

- **Website:** [https://atlarix.dev](https://atlarix.dev)
- **Email:** amariah@norahlabs.com
- **Portfolio:** [https://portfolio-pied-five-61.vercel.app/](https://portfolio-pied-five-61.vercel.app/)

---

**Thank you for helping make Atlarix better!**

© 2024-2025 NorahLabs. All Rights Reserved.

## Testing

### Unit tests

```sh
npm test
```

### E2E tests

Build the app for E2E testing:

```sh
npm run pre:e2e
```

> Note: you only need to re-build the app when changing the app code. You don't need to re-build the app if you're just updating the tests.

Run the whole e2e test suite:

```sh
npm run e2e
```

Run a specific test file:

```sh
npm run e2e e2e-tests/context_manage.spec.ts
```

Update snapshots for a test:

```sh
npm run e2e e2e-tests/context_manage.spec.ts -- --update-snapshots
```
