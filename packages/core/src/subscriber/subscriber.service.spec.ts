import { NotFoundException } from '@nestjs/common';
import { SubscriberService } from './subscriber.service';

/** Fake Prisma covering the unsubscribe/consent queries. */
function makeFakePrisma(seed: any[]) {
  const subscribers = [...seed];
  return {
    subscribers,
    subscriber: {
      findMany: async ({ where }: any) =>
        subscribers
          .filter(
            (s) =>
              s.telegramUserId === where.telegramUserId &&
              s.status === where.status,
          )
          .map((s) => ({ id: s.id, sourceId: s.sourceId })),
      findFirst: async ({ where }: any) =>
        subscribers.find(
          (s) => s.id === where.id && s.sourceId === where.sourceId,
        ) ?? null,
      update: async ({ where, data }: any) => {
        const s = subscribers.find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return s;
      },
    },
  };
}

describe('SubscriberService consent (/stop)', () => {
  it('unsubscribes a Telegram user from every workspace + flags deletion', async () => {
    const fake = makeFakePrisma([
      { id: 's1', sourceId: 'src_A', telegramUserId: 9n, status: 'active', username: null, joinedAt: new Date() },
      { id: 's2', sourceId: 'src_B', telegramUserId: 9n, status: 'active', username: null, joinedAt: new Date() },
      { id: 's3', sourceId: 'src_C', telegramUserId: 1n, status: 'active', username: null, joinedAt: new Date() }, // other user
    ]);
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = new SubscriberService(fake as any, audit as any);

    const count = await svc.unsubscribeByTelegramId(9n);
    expect(count).toBe(2);

    const s1 = fake.subscribers.find((s) => s.id === 's1');
    expect(s1.status).toBe('unsubscribed');
    expect(s1.pendingDelete).toBe(true);
    expect(s1.unsubscribedAt).toBeInstanceOf(Date);
    // The other user is untouched.
    expect(fake.subscribers.find((s) => s.id === 's3').status).toBe('active');
    // One audit entry per affected workspace.
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('REST unsubscribe is tenant-scoped and idempotent', async () => {
    const fake = makeFakePrisma([
      { id: 's1', sourceId: 'src_A', telegramUserId: 9n, status: 'active', username: null, joinedAt: new Date() },
    ]);
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = new SubscriberService(fake as any, audit as any);

    // Another tenant can't unsubscribe this subscriber.
    await expect(svc.unsubscribe('src_B', 's1')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const view = await svc.unsubscribe('src_A', 's1');
    expect(view.status).toBe('unsubscribed');

    audit.record.mockClear();
    const again = await svc.unsubscribe('src_A', 's1'); // idempotent
    expect(again.status).toBe('unsubscribed');
    expect(audit.record).not.toHaveBeenCalled();
  });
});
