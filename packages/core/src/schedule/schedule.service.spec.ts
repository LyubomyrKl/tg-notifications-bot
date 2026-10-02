import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UnfilledPlaceholdersError } from '../notification/placeholder.util';
import { ScheduleService } from './schedule.service';

function makeFakePrisma() {
  const scheduled: any[] = [];
  const notifications = [
    { id: 'n1', sourceId: 'src_A', body: 'Hi {name}', archivedAt: null },
  ];
  const groups = [{ id: 'g_all', sourceId: 'src_A' }];
  let seq = 0;
  return {
    scheduled,
    notification: {
      findFirst: async ({ where }: any) =>
        notifications.find(
          (n) => n.id === where.id && n.sourceId === where.sourceId,
        ) ?? null,
    },
    group: {
      findMany: async ({ where }: any) =>
        groups.filter(
          (g) => where.id.in.includes(g.id) && g.sourceId === where.sourceId,
        ),
    },
    scheduledBroadcast: {
      create: async ({ data }: any) => {
        const row = {
          id: `s_${++seq}`,
          status: 'scheduled',
          lastRunAt: null,
          createdAt: new Date(),
          ...data,
        };
        scheduled.push(row);
        return row;
      },
      findFirst: async ({ where }: any) =>
        scheduled.find((s) => s.id === where.id && s.sourceId === where.sourceId) ??
        null,
      update: async ({ where, data }: any) => {
        const s = scheduled.find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return s;
      },
      delete: async ({ where }: any) => {
        const i = scheduled.findIndex((s) => s.id === where.id);
        if (i >= 0) scheduled.splice(i, 1);
      },
    },
  };
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe('ScheduleService', () => {
  const queue = {
    scheduleOnce: jest.fn().mockResolvedValue(undefined),
    scheduleRepeat: jest.fn().mockResolvedValue(undefined),
    cancelOnce: jest.fn().mockResolvedValue(undefined),
    cancelRepeat: jest.fn().mockResolvedValue(undefined),
  };
  beforeEach(() => Object.values(queue).forEach((f) => f.mockClear()));

  const base = (over: Record<string, unknown> = {}) => ({
    notificationId: 'n1',
    groupIds: ['g_all'],
    placeholderValues: { name: 'Ada' },
    sendAt: future(),
    repeat: 'none' as const,
    ...over,
  });

  it('schedules a one-time send via a delayed job', async () => {
    const fake = makeFakePrisma();
    const svc = new ScheduleService(fake as any, queue as any);
    const v = await svc.schedule('src_A', base(), 'user_1');
    expect(v.status).toBe('scheduled');
    expect(queue.scheduleOnce).toHaveBeenCalledTimes(1);
    expect(queue.scheduleRepeat).not.toHaveBeenCalled();
  });

  it('derives a daily/weekly cron from the anchor time (UTC)', async () => {
    const fake = makeFakePrisma();
    const svc = new ScheduleService(fake as any, queue as any);
    // 2026-07-05T14:30Z is a Sunday (getUTCDay 0).
    await svc.schedule('src_A', base({ sendAt: '2026-07-05T14:30:00.000Z', repeat: 'daily' }), 'u');
    expect(queue.scheduleRepeat.mock.calls[0][1]).toBe('30 14 * * *');
    await svc.schedule('src_A', base({ sendAt: '2026-07-05T14:30:00.000Z', repeat: 'weekly' }), 'u');
    expect(queue.scheduleRepeat.mock.calls[1][1]).toBe('30 14 * * 0');
  });

  it('rejects a past one-time time and unfilled placeholders', async () => {
    const fake = makeFakePrisma();
    const svc = new ScheduleService(fake as any, queue as any);
    await expect(
      svc.schedule('src_A', base({ sendAt: '2020-01-01T00:00:00.000Z' }), 'u'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.schedule('src_A', base({ placeholderValues: {} }), 'u'),
    ).rejects.toBeInstanceOf(UnfilledPlaceholdersError);
  });

  it('rolls the row back when trigger registration fails — no phantom schedules', async () => {
    const fake = makeFakePrisma();
    const svc = new ScheduleService(fake as any, queue as any);
    queue.scheduleOnce.mockRejectedValueOnce(new Error('redis down'));

    await expect(svc.schedule('src_A', base(), 'u')).rejects.toThrow('redis down');
    expect(fake.scheduled).toHaveLength(0); // row deleted, not left "scheduled" forever
  });

  it('is tenant-scoped and cancellable', async () => {
    const fake = makeFakePrisma();
    const svc = new ScheduleService(fake as any, queue as any);
    const v = await svc.schedule('src_A', base(), 'u');

    await expect(svc.cancel('src_B', v.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const cancelled = await svc.cancel('src_A', v.id);
    expect(cancelled.status).toBe('cancelled');
    expect(queue.cancelOnce).toHaveBeenCalledWith(v.id);
  });
});
