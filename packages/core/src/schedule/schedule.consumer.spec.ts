import { UnrecoverableError } from 'bullmq';
import { UnfilledPlaceholdersError } from '../notification/placeholder.util';
import { ScheduleConsumer } from './schedule.consumer';

function makeFakes(row: any) {
  const scheduled = row ? [row] : [];
  const prisma = {
    scheduled,
    scheduledBroadcast: {
      findUnique: async ({ where }: any) =>
        scheduled.find((s) => s.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const s = scheduled.find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return s;
      },
    },
    notification: {
      findFirst: async () => ({ id: 'n1' }),
    },
    group: {
      findMany: async () => [{ id: 'g_all' }],
    },
    source: {
      findUnique: async () => ({ telegramUserId: 999n }),
    },
  };
  const broadcasts = { create: jest.fn().mockResolvedValue({ id: 'b1' }) };
  const queue = { cancelRepeat: jest.fn().mockResolvedValue(undefined) };
  const telegram = { enabled: true, sendText: jest.fn().mockResolvedValue(undefined) };
  const svc = new ScheduleConsumer(
    prisma as any,
    broadcasts as any,
    queue as any,
    telegram as any,
  );
  return { svc, prisma, broadcasts, queue, telegram, scheduled };
}

// fire() is private; exercise it via the same entry BullMQ uses.
const fire = (svc: ScheduleConsumer, jobId: string, scheduledId: string) =>
  (svc as any).fire({ id: jobId, data: { scheduledId } });
const markFailed = (svc: ScheduleConsumer, id: string, reason: string) =>
  (svc as any).markFailed(id, reason);

const base = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  sourceId: 'src_A',
  notificationId: 'n1',
  groupIds: ['g_all'],
  placeholderValues: { name: 'Ada' },
  status: 'scheduled',
  repeat: 'none',
  sendAt: new Date(Date.now() - 60_000), // 1 min ago → due, not stale
  ...over,
});

describe('ScheduleConsumer.fire', () => {
  it('fires a due one-time send and completes the row', async () => {
    const { svc, broadcasts, scheduled } = makeFakes(base());
    const r = await fire(svc, 'j1', 's1');
    expect(r).toBe('fired');
    expect(broadcasts.create).toHaveBeenCalledTimes(1);
    expect(scheduled[0].status).toBe('completed');
  });

  it('skips + fails + notifies a one-time send whose moment long passed', async () => {
    const { svc, broadcasts, telegram, scheduled } = makeFakes(
      base({ sendAt: new Date(Date.now() - 2 * 24 * 3600_000) }), // 2 days late
    );
    const r = await fire(svc, 'j1', 's1');
    expect(r).toBe('stale');
    expect(broadcasts.create).not.toHaveBeenCalled();
    expect(scheduled[0].status).toBe('failed');
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
  });

  it('does not fire a cancelled/failed/completed row', async () => {
    for (const status of ['cancelled', 'failed', 'completed']) {
      const { svc, broadcasts } = makeFakes(base({ status }));
      expect(await fire(svc, 'j1', 's1')).toBe('skipped');
      expect(broadcasts.create).not.toHaveBeenCalled();
    }
  });

  it('turns an unfilled-placeholder failure into an unrecoverable (no futile retries)', async () => {
    const { svc, broadcasts } = makeFakes(base());
    broadcasts.create.mockRejectedValueOnce(
      new UnfilledPlaceholdersError(['name']),
    );
    await expect(fire(svc, 'j1', 's1')).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('rethrows a transient failure as-is (BullMQ will retry)', async () => {
    const { svc, broadcasts } = makeFakes(base());
    broadcasts.create.mockRejectedValueOnce(new Error('redis blip'));
    await expect(fire(svc, 'j1', 's1')).rejects.toThrow('redis blip');
  });
});

describe('ScheduleConsumer.markFailed', () => {
  it('flags the row, removes a recurring trigger, and notifies the owner', async () => {
    const { svc, queue, telegram, scheduled } = makeFakes(
      base({ repeat: 'daily' }),
    );
    await markFailed(svc, 's1', 'template broke');
    expect(scheduled[0].status).toBe('failed');
    expect(queue.cancelRepeat).toHaveBeenCalledWith('s1');
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on a row that is no longer scheduled', async () => {
    const { svc, queue, telegram } = makeFakes(base({ status: 'completed' }));
    await markFailed(svc, 's1', 'x');
    expect(queue.cancelRepeat).not.toHaveBeenCalled();
    expect(telegram.sendText).not.toHaveBeenCalled();
  });
});
