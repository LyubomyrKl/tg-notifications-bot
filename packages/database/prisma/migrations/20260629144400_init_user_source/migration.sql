-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "telegramUserId" BIGINT,
    "apiKeyHash" TEXT NOT NULL,
    "startToken" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sources_telegramUserId_key" ON "sources"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "sources_apiKeyHash_key" ON "sources"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "sources_startToken_key" ON "sources"("startToken");

-- CreateIndex
CREATE INDEX "sources_ownerId_idx" ON "sources"("ownerId");

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
