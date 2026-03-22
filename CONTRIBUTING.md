# Contributing to Square Dashboard Tool

## Development Setup

1. **Clone the repo** and install dependencies:
   ```bash
   git clone <repo-url> && cd SquareDashboardTool
   npm install
   ```

2. **Configure environment**: copy `.env.example` to `.env` and fill in values. At minimum you need database credentials, `TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET`, and Square OAuth keys.

3. **Database**: PostgreSQL 15+. Run migrations:
   ```bash
   set -a && source .env && set +a && npm run migrate
   ```

4. **Start the server**:
   ```bash
   npm run dev    # development (auto-reload)
   npm start      # production
   ```

## Running Tests

```bash
npm test
```

All 4,000+ tests must pass before submitting a PR. New features require tests in the same commit.

## Branch Naming

- Feature branches: `feature/<short-description>`
- Bug fixes: `fix/<short-description>`
- Always branch from an updated `main`:
  ```bash
  git checkout main && git pull origin main
  git checkout -b feature/my-feature
  ```

## Pull Request Process

1. Ensure `npm test` passes with zero failures.
2. Keep PRs focused — one feature or fix per PR.
3. Include a summary of changes and a test plan in the PR description.
4. Reference any related backlog item (e.g., `BACKLOG-42`).

## Code Rules (Summary)

Full details in [CLAUDE.md](./CLAUDE.md). Key rules:

- **Security**: parameterized SQL (`$1, $2`), never string concatenation. All routes require auth.
- **Multi-tenant**: every DB query must filter by `merchant_id`.
- **Response format**: use `utils/response-helper.js` (`sendSuccess`, `sendError`, `sendPaginated`).
- **Error handling**: wrap route handlers with `asyncHandler` — no manual try/catch in routes.
- **Code limits**: functions <= 100 lines, files <= 300 lines, single responsibility per service.
- **Validators**: in `middleware/validators/`, not inline in routes.
- **Business logic**: in `services/`, not in routes.
- **Dependencies**: `npm install --save` or `--save-dev` only. Commit `package.json` and `package-lock.json` together.
- **Env vars**: new `process.env.X` references must have a corresponding entry in `.env.example`.

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Relevant log output (strip PII)
- Node.js version and OS

## Architecture

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full system design, webhook flow, and service structure.
