import { resolveBattleReportGameDate } from '../../src/main/battleReport/battleReportGameDate';
import type { Ck3GameDate } from '../../src/shared/gameData/gameDate';

describe('resolveBattleReportGameDate', () => {
    it('preserves structured totalDays when calendar fields match the battle date', () => {
        const structured: Ck3GameDate = {
            totalDays: 999999,
            year: 868,
            month: 2,
            day: 5,
            display: '868年2月5日'
        };

        expect(resolveBattleReportGameDate('868年2月5日', structured)).toBe(structured);
    });

    it('uses the battle display date when the structured snapshot date is stale', () => {
        const stale: Ck3GameDate = {
            totalDays: 316652,
            year: 867,
            month: 7,
            day: 16,
            display: '867年7月16日'
        };

        const resolved = resolveBattleReportGameDate('868年2月5日', stale);

        expect(resolved).toMatchObject({
            totalDays: 316856,
            year: 868,
            month: 2,
            day: 5,
            display: '868年2月5日'
        });
    });

    it('falls back to a valid structured date when the display date is unavailable', () => {
        const structured: Ck3GameDate = {
            totalDays: 316856,
            year: 868,
            month: 2,
            day: 5,
            display: '868.2.5'
        };

        expect(resolveBattleReportGameDate('', structured)).toBe(structured);
    });
});
