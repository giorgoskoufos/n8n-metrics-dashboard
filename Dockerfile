# Χρησιμοποιούμε την επίσημη ελαφριά έκδοση του Node.js 18
FROM node:18-alpine

# Ορίζουμε ότι όλη η δουλειά μέσα στο container θα γίνει στον φάκελο /app
WORKDIR /app

# Αντιγράφουμε ΠΡΩΤΑ τα package.json (αυτό κάνει το build πολύ πιο γρήγορο)
COPY package*.json ./

# Κατεβάζουμε μόνο τα απαραίτητα πακέτα (Express, pg, dotenv κλπ)
RUN npm install --production

# Αντιγράφουμε όλο τον υπόλοιπο κώδικα (server.js, public folder κλπ)
COPY . .

# Ενημερώνουμε το Docker ότι η εφαρμογή μας ακούει στην πόρτα 3000
EXPOSE 3000

# Η εντολή που θα τρέξει μόλις πατήσεις το "Start" στο Easypanel
CMD ["node", "server.js"]
