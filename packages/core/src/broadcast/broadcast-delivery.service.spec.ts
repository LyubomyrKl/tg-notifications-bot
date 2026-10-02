import { TelegramSendError } from '@paedavic/telegram';
import { BroadcastDeliveryService } from './broadcast-delivery.service';

/** In-memory Prisma + Telegram stub for the per-recipient delivery flow. */
function setup(opts: {
  recipientStatus?: string;
  subscriberStatus?: string;
}) {
  const recipient: any = {
    id: 'r1',
    broadcastId: 'b1',
    status: opts.recipientStatus ?? 'queued',
    error: null,
    sentAt: null,
    subscriber: {
      telegramUserId: 555n,
      status: opts.subscriberStatus ?? 'active',
    },
    broadcast: { notificationId: 'n1', placeholderValues: { name: 'Ada' } },
  };
  const broadcast: any = {
    id: 'b1',
    status: 'queued',
    sentCount: 0,
    failedCount: 0,
    blockedCount: 0,
    groupNames: [],
  };
  const recipients = [recipient];

  const prisma: any = {
    broadcastRecipient: {
      findUnique: async ({ where }: any) =>
        recipients.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }: any) =>
        recipients.filter((r) =>
          where.status?.not ? r.status !== where.status.not : true,
        ),
      // Guarded flip: only a still-queued recipient transitions (matches the
      // real finalize, which uses updateMany with a status guard).
      updateMany: async ({ where, data }: any) => {
        const r = recipients.find((x) => x.id === where.id);
        if (!r || (where.status && r.status !== where.status)) {
          return { count: 0 };
        }
        Object.assign(r, data);
        return { count: 1 };
      },
      count: async ({ where }: any) =>
        recipients.filter((r) => r.status === where.status).length,
    },
    broadcast: {
      update: async ({ data }: any) => {
        if (data.sentCount?.increment) broadcast.sentCount++;
        if (data.failedCount?.increment) broadcast.failedCount++;
        if (data.blockedCount?.increment) broadcast.blockedCount++;
        if (data.status) broadcast.status = data.status;
        if (data.completedAt) broadcast.completedAt = data.completedAt;
        return broadcast;
      },
      updateMany: async ({ where, data }: any) => {
        if (where.status?.not && broadcast.status === where.status.not) {
          return { count: 0 };
        }
        Object.assign(broadcast, data);
        return { count: 1 };
      },
      findUnique: async () => ({
        ...broadcast,
        totalCount: recipients.length,
        notification: { name: 'Promo' },
        source: { telegramUserId: 42n },
      }),
    },
    notification: {
      findUnique: async () => ({ id: 'n1', body: 'Hi {name}' }),
    },
    // Supports both forms: the interactive callback (finalize) and the legacy
    // array form, so either style of caller works against this fake.
    $transaction: async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
  };

  return { prisma, recipient, recipients, broadcast };
}

describe('BroadcastDeliveryService', () => {
  it('sends successfully and completes the broadcast', async () => {
    const { prisma, recipient, broadcast } = setup({});
    const telegram = { sendText: jest.fn().mockResolvedValue(undefined) };
    const svc = new BroadcastDeliveryService(prisma, telegram as any);

    const outcome = await svc.processRecipient('b1', 'r1');
    expect(outcome).toBe('sent');
    expect(telegram.sendText).toHaveBeenCalledWith(555, 'Hi Ada', {
      keyboard: undefined,
    });
    expect(recipient.status).toBe('sent');
    expect(broadcast.sentCount).toBe(1);
    expect(broadcast.status).toBe('completed'); // no queued left
  });

  it('marks blocked (terminal) when Telegram reports a block', async () => {
    const { prisma, recipient, broadcast } = setup({});
    const telegram = {
      sendText: jest
        .fn()
        .mockRejectedValue(new TelegramSendError('blocked', 'bot was blocked')),
    };
    const svc = new BroadcastDeliveryService(prisma, telegram as any);

    expect(await svc.processRecipient('b1', 'r1')).toBe('blocked');
    expect(recipient.status).toBe('blocked');
    expect(broadcast.blockedCount).toBe(1);
  });

  it('rethrows on rate-limit so BullMQ retries with backoff', async () => {
    const { prisma, recipient } = setup({});
    const err = new TelegramSendError('rate_limited', 'slow down', 7);
    const telegram = { sendText: jest.fn().mockRejectedValue(err) };
    const svc = new BroadcastDeliveryService(prisma, telegram as any);

    await expect(svc.processRecipient('b1', 'r1')).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfter: 7,
    });
    expect(recipient.status).toBe('queued'); // unchanged → will retry
  });

  it('is idempotent: an already-sent recipient is skipped', async () => {
    const { prisma } = setup({ recipientStatus: 'sent' });
    const telegram = { sendText: jest.fn() };
    const svc = new BroadcastDeliveryService(prisma, telegram as any);

    expect(await svc.processRecipient('b1', 'r1')).toBe('skipped');
    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  it('respects consent: an unsubscribed recipient is never sent', async () => {
    const { prisma, recipient, broadcast } = setup({
      subscriberStatus: 'unsubscribed',
    });
    const telegram = { sendText: jest.fn() };
    const svc = new BroadcastDeliveryService(prisma, telegram as any);

    expect(await svc.processRecipient('b1', 'r1')).toBe('unsubscribed');
    expect(telegram.sendText).not.toHaveBeenCalled();
    expect(recipient.status).toBe('failed');
    expect(broadcast.failedCount).toBe(1);
  });

  it('reports delivery to the owner, naming exactly who missed out', async () => {
    const { prisma, recipient, recipients } = setup({});
    recipients.push({
      id: 'r2',
      broadcastId: 'b1',
      status: 'blocked',
      error: 'bot was blocked by the user',
      sentAt: null,
      subscriber: {
        telegramUserId: 777n,
        status: 'active',
        name: 'Оля',
        username: null,
        customName: null,
      },
      broadcast: recipient.broadcast,
    });
    const telegram = { enabled: true, sendText: jest.fn().mockResolvedValue(undefined) };
    const svc = new BroadcastDeliveryService(prisma, telegram as any);

    // r1 delivers; r2 is already terminal → the broadcast completes here.
    await svc.processRecipient('b1', 'r1');
    const report = telegram.sendText.mock.calls.at(-1)!;
    expect(report[0]).toBe(42); // the owner's chat, not a subscriber
    expect(report[1]).toContain('→ 555, Оля'); // direct sends name the audience
    expect(report[1]).toContain('Delivered to 1 of 2');
    expect(report[1]).toContain('Оля — blocked the bot');

    // Re-processing a terminal recipient never re-reports (exactly-once).
    const calls = telegram.sendText.mock.calls.length;
    expect(await svc.processRecipient('b1', 'r1')).toBe('skipped');
    expect(telegram.sendText.mock.calls.length).toBe(calls);
  });

  it('a group send reports the targeted group names', async () => {
    const { prisma, recipient, recipients, broadcast } = setup({});
    // Snapshotted at send time — survives a later group deletion.
    broadcast.groupNames = ['Potik-3', 'VIP'];
    recipients.push({
      ...recipient,
      id: 'r2',
      status: 'sent',
      subscriber: { telegramUserId: 777n, status: 'active' },
    });
    broadcast.sentCount = 1; // r2 was already counted
    const telegram = { enabled: true, sendText: jest.fn().mockResolvedValue(undefined) };
    const svc = new BroadcastDeliveryService(prisma, telegram as any);

    await svc.processRecipient('b1', 'r1');
    const report = telegram.sendText.mock.calls.at(-1)!;
    expect(report[0]).toBe(42);
    expect(report[1]).toBe('📬 "Promo" → Potik-3, VIP\nDelivered to all 2 ✅');
  });

  it('a fully delivered 1:1 send reports the recipient by name', async () => {
    const { prisma, recipient } = setup({});
    recipient.subscriber.name = 'Ada L.';
    const telegram = { enabled: true, sendText: jest.fn().mockResolvedValue(undefined) };
    const svc = new BroadcastDeliveryService(prisma, telegram as any);

    await svc.processRecipient('b1', 'r1');
    const report = telegram.sendText.mock.calls.at(-1)!;
    expect(report[0]).toBe(42);
    expect(report[1]).toBe('📬 "Promo" delivered to Ada L. ✅');
  });

  it('markExhausted records terminal failure (idempotent)', async () => {
    const { prisma, recipient, broadcast } = setup({});
    const svc = new BroadcastDeliveryService(prisma, {} as any);

    await svc.markExhausted('b1', 'r1', 'network down');
    expect(recipient.status).toBe('failed');
    expect(broadcast.failedCount).toBe(1);

    await svc.markExhausted('b1', 'r1', 'again'); // no double count
    expect(broadcast.failedCount).toBe(1);
  });
});
