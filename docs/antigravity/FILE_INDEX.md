# 📂 Project File Index

An A-Z index of all core files in the n8n Analytics Dashboard. This index explains the primary responsibility of each file to help agents and developers navigate the codebase efficiently.

---

### **A**
- **aiController.js (`/controllers`)**: The heart of the AI Assistant. Orchestrates the text-to-SQL conversion against the local `dashboard.sqlite` database. 
- **aiRoutes.js (`/routes`)**: Defines the API endpoints for chat interactions and history retrieval.
- **antigravity_tasks.md (Root)**: A persistent technical log tracking all architectural and security updates performed in this workspace.
- **app.js (`/public/logic`)**: The main frontend orchestrator for the dashboard. Handles data fetching for metrics and initializes Chart.js visualizations.
- **auth.js (`/middlewares`)**: Middleware that intercepts API requests to verify JWT identity.
- **authController.js (`/controllers`)**: Manages user session creation against the n8n database, and replicates validated users to the SQLite database.
- **authRoutes.js (`/routes`)**: Defines the login and authentication endpoints.

### **C**
- **chat-widget.js (`/public/logic`)**: Manages the AI Chat UI. Handles Markdown rendering, fluid resizing, and iOS-specific viewport synchronization.

### **D**
- **dashboard.sqlite (Root)**: The dynamic local SQLite database containing synchronized analytics tables and isolated AI chat histories. (Ignored in Git).
- **db.js (`/config`)**: Database configuration. Connects strictly to the production n8n PostgreSQL database for lightweight sync reads and error-detail lookups.

### **F**
- **FILE_INDEX.md (`/docs/antigravity`)**: This index.

### **G**
- **guard.js (`/public/logic`)**: A mission-critical, synchronous authentication guard. Blocks page rendering if no valid session is detected.

### **I**
- **index.html (`/public`)**: The primary dashboard shell. Contains the layout for metrics, charts, and the AI Assistant.

### **L**
- **localDb.js (`/config`)**: Initializes and manages connections to `dashboard.sqlite`, including automatic schema generation.
- **login.js (`/public/logic`)**: Logic for handling the login form interactions and JWT storage.

### **M**
- **metricsController.js (`/controllers`)**: The analytics engine. Generates time-series data using SQLite date functions, and fetches raw error JSONs directly from Postgres.
- **metricsRoutes.js (`/routes`)**: Defines endpoints for retrieving analytical data and triggering manual ETL syncs.

### **O**
- **openai.js (`/config`)**: Centralized initialization of the OpenAI SDK.

### **P**
- **package.json (Root)**: Project manifest defining dependencies (`sqlite3`, `node-cron`, etc.) and core commands.
- **PROJECT_ARCHITECTURE.md (`/docs/antigravity`)**: A high-level blueprint explaining the system's hybrid ETL design decisions.

### **R**
- **rateLimiter.js (`/middlewares`)**: Protection layer against brute-force attacks and OpenAI quota exhaustion.
- **README.md (Root)**: The entry point for humans. Covers setup, environment requirements, and hybrid architecture instructions.

### **S**
- **server.js (Root)**: Application entry point. Configures Express, wires up routes, and kicks off the background ETL synchronization cron job.
- **syncJob.js (`/config`)**: The incremental ETL engine. Polls Postgres for new executions and upserts them into `dashboard.sqlite` securely.

---

*Note: For a high-level overview of system design, refer to @[PROJECT_ARCHITECTURE.md].*
