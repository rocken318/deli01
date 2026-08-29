import { describe, it, expect } from 'vitest';
import { canGenerateDispatch, canGenerateInquiry } from './phone-confirmation';

describe('canGenerateDispatch', () => {
  it('unconfirmed reservation (no phone_confirmed_at) → false', () => {
    expect(canGenerateDispatch({ status: 'confirmed', phone_confirmed_at: null })).toBe(false);
  });

  it('confirmed reservation with phone_confirmed_at set → true', () => {
    expect(canGenerateDispatch({ status: 'confirmed', phone_confirmed_at: new Date() })).toBe(true);
  });

  it('non-confirmed status with phone_confirmed_at → false', () => {
    expect(canGenerateDispatch({ status: 'held', phone_confirmed_at: new Date() })).toBe(false);
  });

  it('phone orders auto-confirmed concept: status=confirmed + phone_confirmed_at set → true', () => {
    // Phone orders are automatically phone_confirmed at save time (source='phone')
    const phoneOrder = { status: 'confirmed', phone_confirmed_at: new Date() };
    expect(canGenerateDispatch(phoneOrder)).toBe(true);
  });
});

describe('canGenerateInquiry', () => {
  it('confirmed → true', () => {
    expect(canGenerateInquiry({ status: 'confirmed' })).toBe(true);
  });

  it('held → false', () => {
    expect(canGenerateInquiry({ status: 'held' })).toBe(false);
  });

  it('cancelled → false', () => {
    expect(canGenerateInquiry({ status: 'cancelled' })).toBe(false);
  });
});
