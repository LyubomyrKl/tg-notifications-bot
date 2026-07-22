-- CreateEnum
CREATE TYPE "InteractionType" AS ENUM ('none', 'poll', 'question');

-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN     "interaction" "InteractionType" NOT NULL DEFAULT 'none',
ADD COLUMN     "pollOptions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "broadcast_responses" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "optionIndex" INTEGER,
    "text" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcast_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "broadcast_responses_sourceId_idx" ON "broadcast_responses"("sourceId");

-- CreateIndex
CREATE INDEX "broadcast_responses_broadcastId_idx" ON "broadcast_responses"("broadcastId");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_responses_broadcastId_subscriberId_key" ON "broadcast_responses"("broadcastId", "subscriberId");

-- AddForeignKey
ALTER TABLE "broadcast_responses" ADD CONSTRAINT "broadcast_responses_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_responses" ADD CONSTRAINT "broadcast_responses_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_responses" ADD CONSTRAINT "broadcast_responses_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
