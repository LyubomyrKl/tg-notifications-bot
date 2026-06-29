-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('queued', 'sending', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "RecipientStatus" AS ENUM ('queued', 'sent', 'failed', 'blocked');

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "sendKey" TEXT NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'queued',
    "placeholderValues" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "blockedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_targets" (
    "broadcastId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "broadcast_targets_pkey" PRIMARY KEY ("broadcastId","groupId")
);

-- CreateTable
CREATE TABLE "broadcast_recipients" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "status" "RecipientStatus" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "broadcasts_sendKey_key" ON "broadcasts"("sendKey");

-- CreateIndex
CREATE INDEX "broadcasts_sourceId_idx" ON "broadcasts"("sourceId");

-- CreateIndex
CREATE INDEX "broadcast_recipients_broadcastId_idx" ON "broadcast_recipients"("broadcastId");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_recipients_broadcastId_subscriberId_key" ON "broadcast_recipients"("broadcastId", "subscriberId");

-- AddForeignKey
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_targets" ADD CONSTRAINT "broadcast_targets_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_targets" ADD CONSTRAINT "broadcast_targets_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
