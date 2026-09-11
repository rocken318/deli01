import { describe, expect, it } from 'vitest';
import { buildTherapistNotice } from './therapist-notice';

describe('buildTherapistNotice', () => {
  it('部屋番号あり・OPあり のフル出力', () => {
    const text = buildTherapistNotice({
      therapistName: 'ゆな',
      startText: '15:00',
      courseName: 'スタンダード',
      courseDurationMin: 90,
      destination: '仙台グランドタワーホテル',
      roomNumber: '302',
      optionNames: ['キス', 'トリップ'],
      totalAmount: 27000,
    });

    expect(text).toContain('【ご案内】ゆな');
    expect(text).toContain('15:00');
    expect(text).toContain('スタンダード');
    expect(text).toContain('90分');
    expect(text).toContain('仙台グランドタワーホテル');
    expect(text).toContain('部屋 302');
    expect(text).toContain('OP キス / トリップ');
    expect(text).toContain('合計 ¥27,000');
  });

  it('部屋番号なし では「部屋」行が省略される', () => {
    const text = buildTherapistNotice({
      therapistName: 'さくら',
      startText: '18:00',
      courseName: 'ライト',
      courseDurationMin: 60,
      destination: '泉区エリア',
      roomNumber: null,
      totalAmount: 12000,
    });

    expect(text).not.toContain('部屋');
    expect(text).toContain('泉区エリア');
  });

  it('OPなし では「OP」行が省略される', () => {
    const text = buildTherapistNotice({
      therapistName: 'みこ',
      startText: '20:00',
      courseName: 'プレミアム',
      courseDurationMin: 120,
      destination: 'ホテルメトロポリタン仙台',
      roomNumber: '501',
      optionNames: [],
      totalAmount: 36000,
    });

    expect(text).not.toContain('OP');
    expect(text).toContain('部屋 501');
  });

  it('電話番号が含まれない', () => {
    // Even if a phone number were somehow passed in entryNote, it must not appear
    const text = buildTherapistNotice({
      therapistName: 'あゆ',
      startText: '14:30',
      courseName: 'スタンダード',
      courseDurationMin: 90,
      destination: '仙台駅前エリア',
      roomNumber: '201',
      entryNote: 'フロントにご連絡ください',
      totalAmount: 18000,
    });

    // No phone pattern in output
    expect(text).not.toMatch(/\d{3}-\d{4}-\d{4}/);
    expect(text).not.toMatch(/090\d{8}/);
    expect(text).toContain('フロントにご連絡ください');
  });
});
