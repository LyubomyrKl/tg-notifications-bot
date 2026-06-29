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
  };
  const recipients = [recipient];

  const prisma: any = {
    broadcastRecipient: {
      findUnique: async ({ where }: any) =>
        recipients.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const r = recipients.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
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
    },
    notification: {
      findUnique: async () => ({ id: 'n1', body: 'Hi {name}' }),
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };

  return { prisma, recipient, broadcast };
}

describe('BroadcastDeliveryService', () => {
  it('sends successfully and completes the broadcast', async () => {
    const { prisma, recipient, broadcast } = setup({});
    const telegram = { sendText: jest.fn().mockResolvedValue(undefined) };
    const svc = new BroadcastDeliveryService(prisma, telegram as any);

    const outcome = await svc.processRecipient('b1', 'r1');
    expect(outcome).toBe('sent');
    expect(telegram.sendText).toHaveBeenCalledWith(555, 'Hi Ada');
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
