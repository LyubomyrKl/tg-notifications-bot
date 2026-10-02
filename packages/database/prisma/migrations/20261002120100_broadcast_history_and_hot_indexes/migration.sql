-- Snapshot of targeted group names at send time, so broadcast history/report
-- survives a later group deletion (BroadcastTarget rows cascade away).
ALTER TABLE "broadcasts" ADD COLUMN "groupNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Hot bot-side lookup: every identity refresh / self-rename / /stop / reader
-- card filters subscribers by telegramUserId alone (across workspaces).
CREATE INDEX "subscribers_telegramUserId_idx" ON "subscribers"("telegramUserId");

-- Per-subscriber delivery history reads broadcast_recipients by subscriberId.
CREATE INDEX "broadcast_recipients_subscriberId_idx" ON "broadcast_recipients"("subscriberId");
