-- CreateTable
CREATE TABLE "WeatherCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "rainExpected" BOOLEAN NOT NULL,
    "maxPrecipProb" REAL NOT NULL,
    "forecastSummary" TEXT NOT NULL,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RainReschedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "originalDay" TEXT NOT NULL,
    "originalDate" TEXT NOT NULL,
    "newDate" TEXT NOT NULL,
    "clientCount" INTEGER NOT NULL,
    "smsCount" INTEGER NOT NULL DEFAULT 0,
    "emailCount" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL,
    "notifiedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WeatherSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "city" TEXT NOT NULL DEFAULT 'Winnipeg',
    "rainThreshold" REAL NOT NULL DEFAULT 0.4,
    "businessStartHour" INTEGER NOT NULL DEFAULT 7,
    "businessEndHour" INTEGER NOT NULL DEFAULT 18,
    "preferredRescheduleDay" TEXT NOT NULL DEFAULT '',
    "checkEnabled" BOOLEAN NOT NULL DEFAULT true
);
