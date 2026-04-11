# 🏗️ n8n Analytics Dashboard Architecture

This document serves as the core logic blueprint for the n8n Analytics Dashboard. It is designed to provide rapid context for AI agents and new developers.

## 1. System Overview
A lightweight, high-performance MVC application that sits alongside a self-hosted n8n instance. It shares the n8n PostgreSQL database but uses a secure, dual-pool connection strategy to protect data integrity.

- **Stack**: Node.js (Express), Vanilla JS (Tailwind/Chart.js), PostgreSQL.
- **Goal**: Real-time workflow analytics with a natural language AI Assistant.

## 2. Database Strategy
The application uses two distinct connection pools (`/config/db.js`):
1.  **Dashboard Pool (`pool`)**: Standard read/write access for metrics and dashboard-specific tables.
2.  **AI Pool (`aiPool`)**: A **Read-Only** connection string (`AI_DB_URL`). 
    - **Safety**: Every AI query is prefixed with `SET statement_timeout = 5000` to prevent runaway executions.

### Key Custom Tables
- `public.dashboard_chat_history`: Stores conversational memory (role, content, user_id, sql_used). Linked to n8n's `public.user`.

## 3. The AI "Text-to-SQL" Pipeline (`aiController.js`)
The AI assistant works in three phases:
- **Intention**: LLM receives the DB schema (workflows, executions) and converts user natural language into PostgreSQL.
- **Execution**: The generated SQL is run against the read-only `aiPool`.
- **Synthesis**: The raw result is returned to the LLM to format into a human-readable response using Markdown.
- **Memory**: The last 10 messages are injected as context to allow follow-up questions.

## 4. Frontend Architecture
The UI is a Single-Page Application (SPA) logic driven by vanilla JS.

- **Security Guard (`logic/guard.js`)**: A synchronous IIFE that blocks page rendering until a valid JWT is found in `localStorage`.
- **Chat Widget (`logic/chat-widget.js`)**: 
    - Handles Markdown rendering (via `marked.js`).
    - **Resizing**: A custom drag-handle calculates deltas relative to the bottom-right anchor.
    - **Breakpoints**: Uses a **1024px** threshold. Below this, the widget enters "Full-Screen Mobile" mode.

## 5. Mobile & iOS Optimizations
We implemented specialized fixes for common mobile web issues:
- **Keyboard Sync**: Uses the `VisualViewport` API to calculate the `offsetTop` and `height` dynamically, ensuring the input field is never buried under the iOS keyboard.
- **Scroll Locking**: When the chat is open on mobile, `document.body` is set to `position: fixed` to prevent background dashboard scrolling ("scroll bleed").
- **Table Swiping**: Tables in chat are wrapped in `.prose-chat` with `overflow-x: auto` to allow horizontal scrolling for wide datasets.

## 6. Authentication Flow
1.  User posts credentials to `/api/login`.
2.  Server verifies against the n8n `user` table.
3.  JWT is returned and stored in `localStorage`.
4.  All API calls use the `fetchWithAuth` wrapper to include the `Authorization` header.

## 7. Development & CI/CD
- **Watch Mode**: `npm run dev` uses the built-in `--watch` flag.
- **Production**: Pushes to `main` trigger an Easypanel webhook via GitHub Actions for automated deployment.
