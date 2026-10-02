import { RecoveryService } from './recovery.service';

describe('RecoveryService.sweep', () => {
  const sendAt = new Date('2026-07-05T14:30:00.000Z'); // Sunday, 14:30 UTC

  function makeFakes(opts: {
    scheduled?: any[];
    stuckBroadcasts?: any[];
    requeued?: number;
    erased?: number;
  }) {
    const prisma = {
      scheduledBroadcast: {
        findMany: jest.fn().mockResolvedValue(opts.scheduled ?? []),
      },
      broadcast: {
        findMany: jest.fn().mockResolvedValue(opts.stuckBroadcasts ?? []),
      },
      subscriber: {
        deleteMany: jest.fn().mockResolvedValue({ count: opts.erased ?? 0 }),
      },
    };
    const scheduleQueue = {
      scheduleOnce: jest.fn().mockResolvedValue(undefined),
      scheduleRepeat: jest.fn().mockResolvedValue(undefined),
    };
    const broadcasts = {
      requeueStuckRecipients: jest.fn().mockResolvedValue(opts.requeued ?? 0),
    };
    const delivery = { completeIfDone: jest.fn().mockResolvedValue(undefined) };
    const svc = new RecoveryService(
      prisma as any,
      scheduleQueue as any,
      broadcasts as any,
      delivery as any,
    );
    return { svc, prisma, scheduleQueue, broadcasts, delivery };
  }

  it('re-registers every live schedule: delayed job for one-time, cron for recurring', async () => {
    const { svc, scheduleQueue } = makeFakes({
      scheduled: [
        { id: 'sch1', sendAt, repeat: 'none' },
        { id: 'sch2', sendAt, repeat: 'daily' },
        { id: 'sch3', sendAt, repeat: 'weekly' },
      ],
    });
    await svc.sweep();

    expect(scheduleQueue.scheduleOnce).toHaveBeenCalledWith('sch1', sendAt);
    expect(scheduleQueue.scheduleRepeat).toHaveBeenCalledWith('sch2', '30 14 * * *', sendAt);
    expect(scheduleQueue.scheduleRepeat).toHaveBeenCalledWith('sch3', '30 14 * * 0', sendAt);
  });

  it('re-enqueues queued recipients of a stuck broadcast', async () => {
    const { svc, broadcasts, delivery } = makeFakes({
      stuckBroadcasts: [{ id: 'b1' }],
      requeued: 3,
    });
    await svc.sweep();

    expect(broadcasts.requeueStuckRecipients).toHaveBeenCalledWith('b1');
    expect(delivery.completeIfDone).not.toHaveBeenCalled();
  });

  it('re-runs the completion check when every recipient is already terminal', async () => {
    // Crash window: last finalize committed, completion update never landed —
    // nothing left to requeue, so only the guarded complete+report is missing.
    const { svc, delivery } = makeFakes({
      stuckBroadcasts: [{ id: 'b1' }],
      requeued: 0,
    });
    await svc.sweep();

    expect(delivery.completeIfDone).toHaveBeenCalledWith('b1');
  });

  it('erases pendingDelete subscribers past the grace window', async () => {
    const { svc, prisma } = makeFakes({ erased: 2 });
    await svc.sweep();

    expect(prisma.subscriber.deleteMany).toHaveBeenCalledTimes(1);
    const where = prisma.subscriber.deleteMany.mock.calls[0][0].where;
    expect(where.pendingDelete).toBe(true);
    expect(where.status).toBe('unsubscribed');
    expect(where.unsubscribedAt.lt).toBeInstanceOf(Date);
  });

  it('does nothing when the world is consistent', async () => {
    const { svc, scheduleQueue, broadcasts, delivery, prisma } = makeFakes({});
    await svc.sweep();

    expect(scheduleQueue.scheduleOnce).not.toHaveBeenCalled();
    expect(scheduleQueue.scheduleRepeat).not.toHaveBeenCalled();
    expect(broadcasts.requeueStuckRecipients).not.toHaveBeenCalled();
    expect(delivery.completeIfDone).not.toHaveBeenCalled();
    // deleteMany still runs (cheap, scoped) but reports 0 erased.
    expect(prisma.subscriber.deleteMany).toHaveBeenCalledTimes(1);
  });
});
