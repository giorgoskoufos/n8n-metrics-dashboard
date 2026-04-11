# 📂 Project File Index

An A-Z index of all core files in the n8n Analytics Dashboard. This index explains the primary responsibility of each file to help agents and developers navigate the codebase efficiently.

---

### **A**
- **AI_DB_URL (.env)**: Environment variable defining the read-only connection string for text-to-SQL safety.
- **aiController.js (`/controllers`)**: The heart of the AI Assistant. Orchestrates the text-to-SQL conversion, enforces 5s timeouts, and manages conversational context.
- **aiRoutes.js (`/routes`)**: Defines the API endpoints for chat interactions and history retrieval.
- **antigravity_tasks.md (Root)**: A persistent technical log tracking all architectural and security updates performed in this workspace.
- **app.js (`/public/logic`)**: The main frontend orchestrator for the dashboard. Handles data fetching for metrics and initializes Chart.js visualizations.
- **auth.js (`/middlewares`)**: Middleware that intercepts API requests to verify JWT identity.
- **authController.js (`/controllers`)**: Manages user session creation and validation against the n8n database.
- **authRoutes.js (`/routes`)**: Defines the login and authentication endpoints.

### **C**
- **chat-widget.js (`/public/logic`)**: Manages the AI Chat UI. Handles Markdown rendering (via marked.js), fluid window resizing, and iOS-specific viewport synchronization.
- **db.js (`/config`)**: Database configuration. Implements dual-pool logic: one for general dashboard use and one for read-only AI queries.

### **G**
- **guard.js (`/public/logic`)**: A mission-critical, synchronous authentication guard. Blocks page rendering if no valid session is detected.

### **I**
- **index.html (`/public`)**: The primary dashboard shell. Contains the layout for metrics, the execution chart, and the floating AI Assistant container.

### **L**
- **login.js (`/public/logic`)**: Logic for handling the login form interactions and JWT storage.

### **M**
- **metricsController.js (`/controllers`)**: The analytics engine. Generates time-series data, identifies error hotspots, and calculates execution stats.
- **metricsRoutes.js (`/routes`)**: Defines endpoints for retrieving all dashboard analytics data.

### **O**
- **openai.js (`/config`)**: Centralized initialization of the OpenAI SDK for the AI Assistant.

### **P**
- **package.json (Root)**: Project manifest defining dependencies, metadata, and core commands (`npm start`, `npm run dev`).
- **PROJECT_ARCHITECTURE.md (Root)**: A high-level blueprint explaining the system's design decisions, mobile optimizations, and data flow.

### **R**
- **rateLimiter.js (`/middlewares`)**: Protection layer against brute-force attacks and OpenAI quota exhaustion.
- **README.md (Root)**: The entry point for humans. Covers setup, environment requirements, and database schema creation.

### **S**
- **server.js (Root)**: Application entry point. Configures Express, attaches global middlewares (Helmet, JSON, Auth), and maps API routes.

---

*Note: For a high-level overview of system design, refer to @[PROJECT_ARCHITECTURE.md].*
