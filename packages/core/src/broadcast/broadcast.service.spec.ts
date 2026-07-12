import { NotFoundException } from '@nestjs/common';
import { UnfilledPlaceholdersError } from '../notification/placeholder.util';
import { BroadcastService } from './broadcast.service';

function makeFakePrisma() {
  const broadcasts: any[] = [];
  const recipientsByBroadcast: Record<string, any[]> = {};
  const notifications: any[] = [
    { id: 'n1', sourceId: 'src_A', body: 'Hi {name}', archivedAt: null },
  ];
  const groups: any[] = [
    { id: 'g_all', sourceId: 'src_A', isAll: true },
    { id: 'g_vip', sourceId: 'src_A', isAll: false },
  ];
  const subscribers: any[] = [
    { id: 's1', sourceId: 'src_A', status: 'active' },
    { id: 's2', sourceId: 'src_A', status: 'active' },
    { id: 's3', sourceId: 'src_A', status: 'unsubscribed' },
  ];
  let bseq = 0;

  return {
    broadcasts,
    recipientsByBroadcast,
    broadcast: {
      findUnique: async ({ where }: any) => {
        const b = broadcasts.find((x) => x.sendKey === where.sendKey);
        return b ? { ...b, targets: b.targets } : null;
      },
      create: async ({ data }: any) => {
        const b = {
          id: `b_${++bseq}`,
          ...data,
          targets: data.targets.create,
          createdAt: new Date(),
          sentCount: 0,
          failedCount: 0,
          blockedCount: 0,
          completedAt: data.completedAt ?? null,
        };
        broadcasts.push(b);
        recipientsByBroadcast[b.id] = data.recipients.create.map(
          (r: any, i: number) => ({ id: `${b.id}_r${i}`, ...r }),
        );
        return b;
      },
    },
    notification: {
      findFirst: async ({ where }: any) =>
        notifications.find(
          (n) =>
            n.id === where.id &&
            n.sourceId === where.sourceId &&
            n.archivedAt === where.archivedAt,
        ) ?? null,
    },
    group: {
      findMany: async ({ where }: any) =>
        groups.filter(
          (g) => where.id.in.includes(g.id) && g.sourceId === where.sourceId,
        ),
    },
    subscriber: {
      findMany: async ({ where }: any) => {
        let rows = subscribers.filter((s) => s.sourceId === where.sourceId);
        // Group-resolution path filters by status; direct-target path by id set.
        if (where.status) rows = rows.filter((s) => s.status === where.status);
        if (where.id?.in) rows = rows.filter((s) => where.id.in.includes(s.id));
        // when not targeting All, a memberships filter is present; our tests
        // only resolve via the All group, so no membership narrowing needed.
        return rows.map((s) => ({ id: s.id, status: s.status }));
      },
    },
    broadcastRecipient: {
      findMany: async ({ where }: any) =>
        recipientsByBroadcast[where.broadcastId] ?? [],
    },
  };
}

describe('BroadcastService.create', () => {
  const queue = { enqueueRecipients: jest.fn().mockResolvedValue(undefined) };
  beforeEach(() => queue.enqueueRecipients.mockClear());

  it('rejects a send with unfilled placeholders', async () => {
    const fake = makeFakePrisma();
    const svc = new BroadcastService(fake as any, queue as any, { record: async () => {} } as any);
    await expect(
      svc.create('src_A', {
        notificationId: 'n1',
        groupIds: ['g_all'],
        subscriberIds: [],
        placeholderValues: {},
        sendKey: 'k1',
      }, 'user_1'),
    ).rejects.toBeInstanceOf(UnfilledPlaceholdersError);
    expect(queue.enqueueRecipients).not.toHaveBeenCalled();
  });

  it('resolves recipients at send time, excluding unsubscribed', async () => {
    const fake = makeFakePrisma();
    const svc = new BroadcastService(fake as any, queue as any, { record: async () => {} } as any);
    const view = await svc.create('src_A', {
      notificationId: 'n1',
      groupIds: ['g_all'],
      subscriberIds: [],
      placeholderValues: { name: 'Ada' },
      sendKey: 'k1',
    }, 'user_1');

    expect(view.totalCount).toBe(2); // s1, s2 active — s3 unsubscribed excluded
    expect(view.status).toBe('queued');
    expect(queue.enqueueRecipients).toHaveBeenCalledTimes(1);
    expect(queue.enqueueRecipients.mock.calls[0][0]).toHaveLength(2);
  });

  it('is idempotent on sendKey — returns existing, no re-enqueue', async () => {
    const fake = makeFakePrisma();
    const svc = new BroadcastService(fake as any, queue as any, { record: async () => {} } as any);
    const first = await svc.create('src_A', {
      notificationId: 'n1',
      groupIds: ['g_all'],
      subscriberIds: [],
      placeholderValues: { name: 'Ada' },
      sendKey: 'dup',
    }, 'user_1');
    queue.enqueueRecipients.mockClear();

    const second = await svc.create('src_A', {
      notificationId: 'n1',
      groupIds: ['g_all'],
      subscriberIds: [],
      placeholderValues: { name: 'Ada' },
      sendKey: 'dup',
    }, 'user_1');

    expect(second.id).toBe(first.id);
    expect(queue.enqueueRecipients).not.toHaveBeenCalled();
  });

  it('sends directly to a specific subscriber (no groups)', async () => {
    const fake = makeFakePrisma();
    const svc = new BroadcastService(fake as any, queue as any, { record: async () => {} } as any);
    const view = await svc.create('src_A', {
      notificationId: 'n1',
      groupIds: [],
      subscriberIds: ['s1'],
      placeholderValues: { name: 'Ada' },
      sendKey: 'k1',
    }, 'user_1');

    expect(view.totalCount).toBe(1);
    expect(view.groupIds).toHaveLength(0);
    expect(queue.enqueueRecipients.mock.calls[0][0]).toHaveLength(1);
  });

  it('unions & dedupes group members with direct subscribers', async () => {
    const fake = makeFakePrisma();
    const svc = new BroadcastService(fake as any, queue as any, { record: async () => {} } as any);
    const view = await svc.create('src_A', {
      notificationId: 'n1',
      groupIds: ['g_all'], // s1, s2
      subscriberIds: ['s1'], // already covered → no double
      placeholderValues: { name: 'Ada' },
      sendKey: 'k1',
    }, 'user_1');

    expect(view.totalCount).toBe(2);
  });

  it('silently drops an unsubscribed direct target (nothing sent)', async () => {
    const fake = makeFakePrisma();
    const svc = new BroadcastService(fake as any, queue as any, { record: async () => {} } as any);
    const view = await svc.create('src_A', {
      notificationId: 'n1',
      groupIds: [],
      subscriberIds: ['s3'], // unsubscribed
      placeholderValues: { name: 'Ada' },
      sendKey: 'k1',
    }, 'user_1');

    expect(view.totalCount).toBe(0);
    expect(view.status).toBe('completed');
    expect(queue.enqueueRecipients.mock.calls[0][0]).toHaveLength(0);
  });

  it('rejects a direct subscriber from another tenant', async () => {
    const fake = makeFakePrisma();
    const svc = new BroadcastService(fake as any, queue as any, { record: async () => {} } as any);
    await expect(
      svc.create('src_A', {
        notificationId: 'n1',
        groupIds: [],
        subscriberIds: ['s_foreign'],
        placeholderValues: { name: 'Ada' },
        sendKey: 'k1',
      }, 'user_1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a notification from another tenant', async () => {
    const fake = makeFakePrisma();
    const svc = new BroadcastService(fake as any, queue as any, { record: async () => {} } as any);
    await expect(
      svc.create('src_B', {
        notificationId: 'n1',
        groupIds: ['g_all'],
        subscriberIds: [],
        placeholderValues: { name: 'Ada' },
        sendKey: 'k1',
      }, 'user_1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
