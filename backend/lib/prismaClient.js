const { PrismaClient } = require('@prisma/client');

// Singleton pattern prevents multiple PrismaClient instances during
// nodemon hot-reloads in development, which would exhaust DB connections.
let prisma;

if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient();
} else {
  if (!global.__prisma) {
    global.__prisma = new PrismaClient({
      log: ['warn', 'error'],
    });
  }
  prisma = global.__prisma;
}

module.exports = prisma;
