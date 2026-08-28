import type { MilitarySnapshot, WarInfo, ArmyInfo, WarSide } from '../../shared/gameData/GameData';

/**
 * Military situation brief formatter, ported from 1.x
 * default_userdata/scripts/prompts/description/standard/militaryBrief.js
 * (P3). Renders the parsed MilitarySnapshot into a compact prompt block for
 * the conversation system prompt and the battle-report prompt. 1.x shipped
 * Chinese-only (Phase 1); this port carries an English table alongside so
 * both app languages get native text instead of mixed-language prompts.
 */

export type BriefLanguage = 'en' | 'zh';

export interface MilitaryBriefOptions {
    maxChars?: number;
    lang?: BriefLanguage;
}

type BriefTable = {
    header: (date: string) => string;
    warTitle: (id: number, name: string) => string;
    playerSide: (side: WarSide) => string;
    startDate: (date: string) => string;
    casusBelli: (cb: string) => string;
    targetTitle: (name: string) => string;
    situation: string;
    separator: string;
    participants: string;
    participantLine: (name: string, side: WarSide, strength?: number) => string;
    sideShort: (side: WarSide) => string;
    sieges: string;
    siegeLine: (parts: { location: string; commander?: string; attackerMen?: number; defenderMen?: number; progress?: number }) => string;
    truncation: (omitted: number, total: number) => string;
    armies: string;
    armyUnnamed: string;
    armySoldiers: (soldiers: number, max?: number) => string;
    armyOwner: (name: string) => string;
    armyCommander: (name: string) => string;
    playerArmyTagOpen: string;
    armySlot: (slot: number) => string;
    playerArmyTagClose: string;
    armyLocation: (name: string) => string;
    armyStateLabel: string;
    armyStates: { gathering: string; moving: string; embarked: string; retreating: string; inCombat: string; inSiege: string };
    armyStateIdle: string;
    armySupply: (value: number) => string;
    armyAttrition: (value: number) => string;
    regimentsLabel: string;
    recentEvents: string;
    eventLine: (date: string, type: string, payload: string) => string;
    dataLimits: string;
    attendeesTitle: string;
    attendeeLine: (parts: { name: string; roles: string; slots?: string; canCommand: boolean }) => string;
    canAppoint: string;
    cannotAppoint: string;
    advantageDegrees: { extreme: string; clear: string; slight: string; even: string; slightBad: string; clearBad: string; extremeBad: string };
    componentNone: string;
    componentTrace: string;
    componentSome: string;
    componentSignificant: string;
    componentMassive: string;
    advantage: string;
    disadvantage: string;
    componentLabels: { battles: string; occupation: string; imprisonment: string; ticking: string };
};

const ZH: BriefTable = {
    header: (date) => `\n[军事态势快照：${date}；仅反映采集时刻]\n`,
    warTitle: (id, name) => `\n战争 #${id}：${name}。\n`,
    playerSide: (side) => `你方为${side === 'attacker' ? '进攻方' : '防守方'}。\n`,
    startDate: (date) => `开战日：${date}。\n`,
    casusBelli: (cb) => `开战理由：${cb}。\n`,
    targetTitle: (name) => `目标：${name}。\n`,
    situation: '当前战局：',
    separator: '；',
    participants: '参战者：\n',
    participantLine: (name, side, strength) => {
        let line = `  - ${name}（${side === 'attacker' ? '攻方' : '守方'}）`;
        if (strength !== undefined) line += `，兵力 ${strength}`;
        return line + `\n`;
    },
    sideShort: (side) => (side === 'attacker' ? '攻方' : '守方'),
    sieges: '围城（可能与多场战争有关，因 Siege.GetWar 不存在）：\n',
    siegeLine: (p) => {
        let line = `  - ${p.location}`;
        if (p.commander) line += `，统帅 ${p.commander}`;
        if (p.attackerMen !== undefined) line += `，攻方 ${p.attackerMen}`;
        if (p.defenderMen !== undefined) line += `，守方 ${p.defenderMen}`;
        if (p.progress !== undefined) line += `，进度 ${p.progress}%`;
        return line + `\n`;
    },
    truncation: (omitted, total) => `[此战争已省略 ${omitted} 项次要数据（共 ${total} 项）。]\n`,
    armies: '\n军队（possibleWarAssociation=true，多线战争不保证专属）：\n',
    armyUnnamed: '军队',
    armySoldiers: (soldiers, max) => `：兵力 ${soldiers}${max !== undefined ? '/' + max : ''}`,
    armyOwner: (name) => `，所有者 ${name}`,
    armyCommander: (name) => `，统帅 ${name}`,
    playerArmyTagOpen: `【玩家军队`,
    armySlot: (slot) => `，slot ${slot}`,
    playerArmyTagClose: `】`,
    armyLocation: (name) => `，位置 ${name}`,
    armyStateLabel: '，状态：',
    armyStates: { gathering: '集结中', moving: '行军中', embarked: '登船中', retreating: '撤退中', inCombat: '作战中', inSiege: '围城中' },
    armyStateIdle: '驻扎',
    armySupply: (value) => `，补给 ${value}`,
    armyAttrition: (value) => `，损耗 ${value}%`,
    regimentsLabel: '    - 兵团构成：',
    recentEvents: '\n近期事件：\n',
    eventLine: (date, type, payload) => `  - ${date}：${type}${payload ? '（' + payload + '）' : ''}\n`,
    dataLimits: '\n[数据限制：敌军行军终点和地图路径不可用；多线战争中军队关联为"可能"而非专属；围城可能与多场战争有关。]\n',
    attendeesTitle: '\n军事会议与会者：\n',
    attendeeLine: (p) => {
        let line = `  - ${p.name}（${p.roles}`;
        if (p.slots) line += `，统辖 slot ${p.slots}`;
        line += p.canCommand ? `，可被任命` : `，不可被任命`;
        return line + `）\n`;
    },
    canAppoint: '可被任命',
    cannotAppoint: '不可被任命',
    advantageDegrees: {
        extreme: '我方占压倒性优势',
        clear: '我方占明显优势',
        slight: '我方稍占优势',
        even: '双方势均力敌',
        slightBad: '我方稍处劣势',
        clearBad: '我方处明显劣势',
        extremeBad: '我方处压倒性劣势'
    },
    componentNone: '无',
    componentTrace: '些许',
    componentSome: '一定',
    componentSignificant: '显著',
    componentMassive: '极大',
    advantage: '优势',
    disadvantage: '劣势',
    componentLabels: { battles: '野战交锋', occupation: '占地', imprisonment: '擒获', ticking: '持久' }
};

const EN: BriefTable = {
    header: (date) => `\n[Military situation snapshot: ${date}; reflects the moment of capture only]\n`,
    warTitle: (id, name) => `\nWar #${id}: ${name}.\n`,
    playerSide: (side) => `Our side is the ${side === 'attacker' ? 'attacker' : 'defender'}.\n`,
    startDate: (date) => `War started: ${date}.\n`,
    casusBelli: (cb) => `Casus belli: ${cb}.\n`,
    targetTitle: (name) => `Target: ${name}.\n`,
    situation: 'Current situation: ',
    separator: '; ',
    participants: 'Participants:\n',
    participantLine: (name, side, strength) => {
        let line = `  - ${name} (${side === 'attacker' ? 'attacker' : 'defender'})`;
        if (strength !== undefined) line += `, strength ${strength}`;
        return line + `\n`;
    },
    sideShort: (side) => (side === 'attacker' ? 'attacker' : 'defender'),
    sieges: 'Sieges (may relate to several wars, as Siege.GetWar does not exist):\n',
    siegeLine: (p) => {
        let line = `  - ${p.location}`;
        if (p.commander) line += `, commander ${p.commander}`;
        if (p.attackerMen !== undefined) line += `, attackers ${p.attackerMen}`;
        if (p.defenderMen !== undefined) line += `, defenders ${p.defenderMen}`;
        if (p.progress !== undefined) line += `, progress ${p.progress}%`;
        return line + `\n`;
    },
    truncation: (omitted, total) => `[${omitted} of ${total} minor entries omitted for this war.]\n`,
    armies: '\nArmies (possibleWarAssociation=true; not guaranteed to belong to one war):\n',
    armyUnnamed: 'army',
    armySoldiers: (soldiers, max) => `: ${soldiers}${max !== undefined ? '/' + max : ''} soldiers`,
    armyOwner: (name) => `, owner ${name}`,
    armyCommander: (name) => `, commander ${name}`,
    playerArmyTagOpen: ` [player's army`,
    armySlot: (slot) => `, slot ${slot}`,
    playerArmyTagClose: `]`,
    armyLocation: (name) => `, at ${name}`,
    armyStateLabel: ', status: ',
    armyStates: { gathering: 'gathering', moving: 'marching', embarked: 'embarked', retreating: 'retreating', inCombat: 'in combat', inSiege: 'besieging' },
    armyStateIdle: 'stationed',
    armySupply: (value) => `, supply ${value}`,
    armyAttrition: (value) => `, attrition ${value}%`,
    regimentsLabel: '    - Regiments: ',
    recentEvents: '\nRecent events:\n',
    eventLine: (date, type, payload) => `  - ${date}: ${type}${payload ? ' (' + payload + ')' : ''}\n`,
    dataLimits: '\n[Data limits: enemy march targets and map paths unavailable; in multi-war situations army association is "possible" rather than exclusive; a siege may relate to several wars.]\n',
    attendeesTitle: '\nMilitary council attendees:\n',
    attendeeLine: (p) => {
        let line = `  - ${p.name} (${p.roles}`;
        if (p.slots) line += `, commands slot ${p.slots}`;
        line += p.canCommand ? `, appointable` : `, not appointable`;
        return line + `)\n`;
    },
    canAppoint: 'appointable',
    cannotAppoint: 'not appointable',
    advantageDegrees: {
        extreme: 'we hold an overwhelming advantage',
        clear: 'we hold a clear advantage',
        slight: 'we hold a slight advantage',
        even: 'the two sides are evenly matched',
        slightBad: 'we are at a slight disadvantage',
        clearBad: 'we are at a clear disadvantage',
        extremeBad: 'we are at an overwhelming disadvantage'
    },
    componentNone: 'none',
    componentTrace: 'trace',
    componentSome: 'some',
    componentSignificant: 'significant',
    componentMassive: 'massive',
    advantage: ' advantage',
    disadvantage: ' disadvantage',
    componentLabels: { battles: 'Field battles', occupation: 'Occupation', imprisonment: 'Captures', ticking: 'Ticking' }
};

const TABLES: Record<BriefLanguage, BriefTable> = { en: EN, zh: ZH };

const ROLE_LABELS: Record<BriefLanguage, Record<string, string>> = {
    en: {
        marshal: 'marshal',
        field_commander: 'field commander',
        knight: 'knight',
        commander_candidate: 'commander candidate',
        war_leader_adviser: 'war adviser'
    },
    zh: {
        marshal: '元帅',
        field_commander: '前线将领',
        knight: '骑士',
        commander_candidate: '指挥候选',
        war_leader_adviser: '军议顾问'
    }
};

/**
 * Format a military brief string from the snapshot for injection into prompts.
 * Returns an empty string when there is no complete snapshot with wars.
 */
export function formatMilitaryBrief(snapshot: MilitarySnapshot | undefined | null, options: MilitaryBriefOptions = {}): string {
    if (!snapshot || !snapshot.complete || snapshot.wars.size === 0) {
        return '';
    }

    const lang: BriefLanguage = options.lang === 'zh' ? 'zh' : 'en';
    const t = TABLES[lang];
    const roleLabel = (role: string) => ROLE_LABELS[lang][role] ?? role;

    const maxChars = options.maxChars || 12000;
    let output = '';
    let charsUsed = 0;

    const fits = (line: string) => charsUsed + line.length <= maxChars;

    // War score values are always stored from the attacker's perspective; we
    // flip the sign when the player is the defender so the description matches
    // the player's actual situation.
    function describeAdvantage(signedTotal: number): string {
        if (signedTotal >= 80) return t.advantageDegrees.extreme;
        if (signedTotal >= 50) return t.advantageDegrees.clear;
        if (signedTotal >= 20) return t.advantageDegrees.slight;
        if (signedTotal >= -20) return t.advantageDegrees.even;
        if (signedTotal >= -50) return t.advantageDegrees.slightBad;
        if (signedTotal >= -80) return t.advantageDegrees.clearBad;
        return t.advantageDegrees.extremeBad;
    }

    function describeComponent(value: number): string {
        if (value === 0) return t.componentNone;
        if (value <= 10) return t.componentTrace;
        if (value <= 30) return t.componentSome;
        if (value <= 50) return t.componentSignificant;
        return t.componentMassive;
    }

    function describeRelativeComponent(value: number, playerSide: WarSide, label: string): string {
        const signedValue = playerSide === 'attacker' ? value : -value;
        const magnitude = describeComponent(Math.abs(signedValue));
        if (magnitude === t.componentNone) return `${label}${t.componentNone}`;
        const direction = signedValue > 0 ? t.advantage : t.disadvantage;
        return `${label}${direction}${magnitude}`;
    }

    output += t.header(snapshot.snapshotDate);
    charsUsed = output.length;

    for (const [, war] of snapshot.wars) {
        output += renderWar(war, t, { describeAdvantage, describeRelativeComponent, fits });
        charsUsed = output.length;
    }

    // CK3 armies are not owned by a single war, so they are shown at snapshot level.
    if (snapshot.armies.length > 0) {
        output += t.armies;
        for (const army of snapshot.armies) {
            const armyLines = renderArmy(army, t);
            for (const line of armyLines) {
                if (!fits(line)) break;
                output += line;
                charsUsed += line.length;
            }
        }
    }

    if (snapshot.events.length > 0) {
        output += t.recentEvents;
        for (const ev of snapshot.events) {
            const line = t.eventLine(ev.date, ev.type, ev.payload);
            if (!fits(line)) break;
            output += line;
            charsUsed += line.length;
        }
    }

    output += t.dataLimits;

    if (snapshot.attendees.length > 0) {
        output += t.attendeesTitle;
        for (const att of snapshot.attendees) {
            const line = t.attendeeLine({
                name: att.character.name,
                roles: att.roles.map(roleLabel).join(lang === 'zh' ? '、' : ', '),
                slots: att.commandSlots.length > 0 ? att.commandSlots.join(',') : undefined,
                canCommand: att.canCommandPlayerArmies
            });
            if (!fits(line)) break;
            output += line;
            charsUsed += line.length;
        }
    }

    return output;

    function renderWar(
        war: WarInfo,
        table: BriefTable,
        helpers: {
            describeAdvantage: (signedTotal: number) => string;
            describeRelativeComponent: (value: number, playerSide: WarSide, label: string) => string;
            fits: (line: string) => boolean;
        }
    ): string {
        let warOutput = table.warTitle(war.id, war.name);
        warOutput += table.playerSide(war.playerSide);
        if (war.startDate) warOutput += table.startDate(war.startDate);
        if (war.casusBelli) warOutput += table.casusBelli(war.casusBelli);
        if (war.targetTitle) warOutput += table.targetTitle(war.targetTitle.name);

        const score = war.score;
        const signedTotal = war.playerSide === 'attacker' ? score.total : -score.total;
        const partDescs: string[] = [];
        if (score.battles !== undefined && score.battles !== 0) {
            partDescs.push(helpers.describeRelativeComponent(score.battles, war.playerSide, table.componentLabels.battles));
        }
        if (score.occupation !== undefined && score.occupation !== 0) {
            partDescs.push(helpers.describeRelativeComponent(score.occupation, war.playerSide, table.componentLabels.occupation));
        }
        if (score.imprisonment !== undefined && score.imprisonment !== 0) {
            partDescs.push(helpers.describeRelativeComponent(score.imprisonment, war.playerSide, table.componentLabels.imprisonment));
        }
        if (score.ticking !== undefined && score.ticking !== 0) {
            partDescs.push(helpers.describeRelativeComponent(score.ticking, war.playerSide, table.componentLabels.ticking));
        }
        warOutput += table.situation + helpers.describeAdvantage(signedTotal);
        if (partDescs.length > 0) {
            warOutput += table.separator + partDescs.join(lang === 'zh' ? '、' : ', ');
        }
        warOutput += '\n';

        if (war.participants.length > 0) {
            warOutput += table.participants;
            for (const p of war.participants) {
                const line = table.participantLine(p.character.name, p.side, p.militaryStrength);
                if (!helpers.fits(warOutput + line)) break;
                warOutput += line;
            }
        }

        if (war.sieges.length > 0) {
            warOutput += table.sieges;
            for (const siege of war.sieges) {
                const line = table.siegeLine({
                    location: siege.location.name,
                    commander: siege.commander?.name,
                    attackerMen: siege.attackerMen,
                    defenderMen: siege.defenderMen,
                    progress: siege.progress
                });
                if (!helpers.fits(warOutput + line)) break;
                warOutput += line;
            }
        }

        if (war.truncation && war.truncation.omitted > 0) {
            warOutput += table.truncation(war.truncation.omitted, war.truncation.total);
        }
        return warOutput;
    }

    function renderArmy(army: ArmyInfo, table: BriefTable): string[] {
        let line = `  - ${army.name || table.armyUnnamed}`;
        line += table.armySoldiers(army.soldiers, army.maxSoldiers);
        line += table.armyOwner(army.owner.name);
        if (army.commander) line += table.armyCommander(army.commander.name);
        if (army.isPlayerOwned) line += table.playerArmyTagOpen;
        if (army.commandSlot) line += table.armySlot(army.commandSlot);
        if (army.isPlayerOwned) line += table.playerArmyTagClose;
        if (army.location) line += table.armyLocation(army.location.name);
        line += table.armyStateLabel;
        const states: string[] = [];
        if (army.state.gathering) states.push(table.armyStates.gathering);
        if (army.state.moving) states.push(table.armyStates.moving);
        if (army.state.embarked) states.push(table.armyStates.embarked);
        if (army.state.retreating) states.push(table.armyStates.retreating);
        if (army.state.inCombat) states.push(table.armyStates.inCombat);
        if (army.state.inSiege) states.push(table.armyStates.inSiege);
        line += states.length > 0 ? states.join(lang === 'zh' ? '、' : ', ') : table.armyStateIdle;
        if (army.supply !== undefined) line += table.armySupply(army.supply);
        if (army.attrition !== undefined && army.attrition !== 0) line += table.armyAttrition(army.attrition);
        line += '\n';

        const lines = [line];
        if (army.regiments && army.regiments.length > 0) {
            const regimentParts = army.regiments.map(r => {
                const maxPart = r.max !== undefined ? `/${r.max}` : '';
                return `${r.typeName} ${r.count}${maxPart}`;
            });
            lines.push(table.regimentsLabel + regimentParts.join(lang === 'zh' ? '、' : ', ') + '\n');
        }
        return lines;
    }
}
