import {
    parseLegacyCk3DisplayDate,
    validateCk3GameDate,
    type Ck3GameDate
} from '../../shared/gameData/gameDate.js';

/**
 * Resolve the canonical date of a battle report.
 *
 * The battle block's display date belongs to the battle itself. The optional
 * structured date can come from the most recent general GameData snapshot,
 * which may describe an earlier event. Its totalDays still provides the CK3
 * epoch anchor: display-date parsing uses a local Gregorian epoch that can
 * differ from CK3, while the day delta between two calendar dates is stable.
 */
export function resolveBattleReportGameDate(
    displayDate: unknown,
    structuredDate: unknown
): Ck3GameDate | undefined {
    const parsedDisplay = typeof displayDate === 'string'
        ? parseLegacyCk3DisplayDate(displayDate)
        : undefined;
    const validStructured = validateCk3GameDate(structuredDate).valid
        ? structuredDate as Ck3GameDate
        : undefined;

    if (!parsedDisplay) return validStructured;
    if (!validStructured) return parsedDisplay;

    const sameCalendarDate = parsedDisplay.year === validStructured.year
        && parsedDisplay.month === validStructured.month
        && parsedDisplay.day === validStructured.day;

    if (sameCalendarDate) return validStructured;

    const structuredCalendar = parseLegacyCk3DisplayDate(
        `${validStructured.year}.${validStructured.month}.${validStructured.day}`
    );
    if (!structuredCalendar) return parsedDisplay;

    return {
        ...parsedDisplay,
        totalDays: validStructured.totalDays
            + (parsedDisplay.totalDays - structuredCalendar.totalDays)
    };
}
