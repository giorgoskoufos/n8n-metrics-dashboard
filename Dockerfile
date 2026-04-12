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

# Tell Docker the application listens on port 3000
EXPOSE 3000

# Startup command for the container
CMD ["node", "server.js"]
