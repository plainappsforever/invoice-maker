import { TimeoutError, withTimeout } from './timeout';

describe('withTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('passes a result that comes in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'PDF')).resolves.toBe(7);
  });
  it('passes the original error', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'PDF')).rejects.toThrow('boom');
  });
  it('rejects with a TimeoutError when the work never settles', async () => {
    const never = new Promise<number>(() => undefined);
    const result = withTimeout(never, 60_000, 'Creating the PDF');
    jest.advanceTimersByTime(60_000);
    await expect(result).rejects.toBeInstanceOf(TimeoutError);
    await expect(result).rejects.toThrow('Creating the PDF took longer than 60 s');
  });
});
