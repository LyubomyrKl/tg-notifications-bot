import { UnrecoverableError } from 'bullmq';
import { isTerminalDeliveryFailure } from './broadcast.consumer';

describe('isTerminalDeliveryFailure', () => {
  const job = (attemptsMade: number, attempts = 5) => ({
    attemptsMade,
    opts: { attempts },
  });

  it('retries a transient failure with attempts remaining', () => {
    expect(isTerminalDeliveryFailure(job(1), new Error('timeout'))).toBe(false);
    expect(isTerminalDeliveryFailure(job(4), new Error('timeout'))).toBe(false);
  });

  it('is terminal once attempts are spent', () => {
    expect(isTerminalDeliveryFailure(job(5), new Error('timeout'))).toBe(true);
  });

  it('is terminal on an UnrecoverableError even at attempt 1 (stall-exhausted job)', () => {
    // BullMQ fails a job stalled beyond maxStalledCount with an
    // UnrecoverableError while attemptsMade is still low — previously misread
    // as "will retry", leaving the recipient queued and the broadcast wedged.
    expect(
      isTerminalDeliveryFailure(
        job(1),
        new UnrecoverableError('job stalled more than allowable limit'),
      ),
    ).toBe(true);
  });

  it('falls back to the error name when the class instance differs', () => {
    const err = new Error('job stalled more than allowable limit');
    err.name = 'UnrecoverableError';
    expect(isTerminalDeliveryFailure(job(1), err)).toBe(true);
  });
});
