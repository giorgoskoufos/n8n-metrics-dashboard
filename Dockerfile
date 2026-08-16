# Use the official lightweight Node.js 18 image
FROM node:18-alpine

# Define the working directory inside the container
WORKDIR /app

# Copy package files first to leverage Docker cache
COPY package*.json ./

# Install only production dependencies (Express, pg, dotenv, etc.)
RUN npm install --production

# Copy the rest of the application code (server.js, public folder, etc.)
COPY . .

# The analytics replica must outlive the container. It keeps execution history
# that n8n has already pruned from Postgres, so losing it means losing data that
# cannot be re-synced. Mount a named volume at /data — see README.
ENV DASHBOARD_DB_PATH=/data/dashboard.sqlite
RUN mkdir -p /data
VOLUME ["/data"]

# Tell Docker the application listens on port 3000
EXPOSE 3000

# Startup command for the container
CMD ["node", "server.js"]
