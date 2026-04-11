# n8n Analytics Dashboard - Refactoring & Security Plan

This task list outlines the steps to secure the application, modularize the backend architecture, and improve frontend authentication flows.

## Phase 1: Security Enhancements ("Make it safe")
- [x] **Implement Rate Limiting**: Add `express-rate-limit` to prevent brute-force attacks on the `/api/login` endpoint and abuse of the `/api/ai-chat` OpenAI integration.
- [x] **Add Basic Security Headers**: Install and configure `helmet` to set secure HTTP headers (e.g., XSS Protection, CSP, no-sniff).
- [x] **Validate AI Text-to-SQL**: Ensure the generated SQL execution has a strict timeout (e.g., `statement_timeout`) to prevent denial-of-service via complex generated queries.
- [x] **Input Sanitization**: Ensure all query parameters (e.g., `limit`, `offset`) are strictly typed and sanitized before hitting the database.

## Phase 2: Backend Modularization
Transform the monolithic `server.js` into an MVC-style structure.

- [x] **Create Directory Structure**:
  - `config/` (Database & external service setups)
  - `middlewares/` (Auth, rate limiters)
  - `controllers/` (Route logic)
  - `routes/` (Express routers)
- [x] **Extract Database Configuration (`config/db.js`)**: Move `pool` and `aiPool` initialization.
- [x] **Extract Middleware (`middlewares/auth.js`)**: Move `authenticateToken` logic.
- [x] **Extract Authentication (`controllers/authController.js` & `routes/authRoutes.js`)**: Move `POST /api/login`.
- [x] **Extract Metrics (`controllers/metricsController.js` & `routes/metricsRoutes.js`)**: Move `/api/metrics`, `/api/executions`, `/api/analytics/*`, and `/api/execution-error/:id`.
- [x] **Extract AI Chat (`controllers/aiController.js` & `routes/aiRoutes.js`)**: Move `POST /api/ai-chat` and OpenAI initialization.
- [x] **Simplify `server.js`**: Refactor to only handle middleware setup, route registration, and starting the server listener.

## Phase 3: Frontend Route Guarding
Ensure all protected pages use the authentication guard properly.

- [x] **Audit `public/index.html`**: Verify `<script src="logic/guard.js"></script>` is the first executed script in the `<head>`.
- [x] **Audit `public/pages/chat.html`**: Inject `<script src="../logic/guard.js"></script>` to ensure unauthenticated users cannot access the chat.
- [x] **Review `public/logic/guard.js`**: Verify the pathing logic correctly routes users to the login page regardless of their current directory depth.

## Phase 4: Logout Implementation
Provide users a straightforward way to end their session.

- [x] **UI Updates**:
  - [x] Add a "Logout" button/icon in the header of `public/index.html`.
  - [x] Add a "Logout" button/icon in the header of `public/pages/chat.html`.
- [x] **Logic Updates**:
  - [x] Create a reusable `logout()` function (could be added to `guard.js` or `app.js`).
  - [x] Clear `n8n_auth_token` from `localStorage`.
  - [x] Redirect the user to `login.html`.
