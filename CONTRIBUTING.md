# Contributing

Thank you for helping. Bug reports, tests, translations and documentation fixes are as welcome as code.

## Set up

```
git clone https://github.com/INCONNU-BOY/INCONNU-BOY-APK-BUILDER.git
cd INCONNU-BOY-APK-BUILDER
npm install
npm test
```

Node.js 22.13 or newer is required. `npm test` also needs bash, git, tar and python3 with PyYAML. Browser tests need Chromium: `npx playwright install chromium`, then `npm run test:browser`. `npm run test:all` runs everything.

Real Android builds also need JDK 17, Gradle 8.9 and an Android SDK; see the README. Contributions that exercise a real build and report the result are especially valuable, because the pipeline has only been tested with a stubbed Gradle.

## Rules

- **No comments** in source or configuration files: no `//`, `/* */`, `<!--`, `#` comments or TODO markers. Use clear names and small functions. A repository test enforces this. Documentation (`.md`) is the place for explanations.
- Every behavior change needs a test. Security-relevant code needs tests for the failure paths.
- Do not report something as verified unless a test or a real run proved it. Documentation must state what was and was not verified.
- User-visible text goes through `frontend/js/locales/`. Add every key to English, French and Portuguese; a test checks that the catalogs match.
- Keep dependencies few and pinned. Explain any new dependency in the pull request.
- Never commit keystores, passwords or `.env` files.

## Workflow

1. Open an issue for anything larger than a small fix.
2. Create a branch, make focused commits with clear messages.
3. Run `npm run test:all` and, for shell changes, `bash -n` on the scripts (CI also runs ShellCheck).
4. Open a pull request describing the change, the tests added and what you could not verify.

By contributing you agree that your work is released under the MIT license.
