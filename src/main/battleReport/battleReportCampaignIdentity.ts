import {
    buildIdentityFromParts,
    type CampaignPlayerIdentity
} from '../../shared/gameData/CampaignIdentity.js';
import {
    TIMELINE_CAMPAIGN_SCHEMA,
    TIMELINE_PROTOCOL_SCHEMA
} from '../../shared/gameData/timelineProtocol.js';

export interface BattleReportCampaignContext {
    identity: CampaignPlayerIdentity;
    deliveryId: number;
}

/**
 * Parse the campaign identity emitted inside a battle-report block:
 *
 * VOTC:BATTLE_REPORT/;/campaign/;/player/;/protocol/;/campaignSchema
 * /;/campaignIdA/;/campaignIdB/;/campaignIdC/;/campaignIdD/;/deliveryId
 *
 * The identity belongs to this exact battle occurrence, so it is the source
 * of truth for battle timeline/history work. Do not substitute a later
 * VOTC:IN snapshot here: it may be from another game session or unavailable.
 */
export function parseBattleReportCampaignIdentityPayload(
    payloads: readonly string[] | undefined,
    expectedPlayerId: string
): BattleReportCampaignContext {
    if (!payloads || payloads.length < 9 || payloads[0] !== 'campaign') {
        throw new Error('Battle report is missing its V2 campaign identity payload.');
    }

    const playerId = payloads[1];
    if (!playerId || playerId !== expectedPlayerId) {
        throw new Error(
            `Battle report player mismatch: init contains ${expectedPlayerId || '(empty)'}, campaign line contains ${playerId || '(empty)'}.`
        );
    }

    const protocolSchema = Number(payloads[2]);
    const campaignSchema = Number(payloads[3]);
    if (protocolSchema !== TIMELINE_PROTOCOL_SCHEMA) {
        throw new Error(`Unsupported battle report protocol schema: ${payloads[2]}.`);
    }
    if (campaignSchema !== TIMELINE_CAMPAIGN_SCHEMA) {
        throw new Error(`Unsupported battle report campaign schema: ${payloads[3]}.`);
    }

    const deliveryId = Number(payloads[8]);
    if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) {
        throw new Error(`Battle report campaign line has an invalid delivery id: ${payloads[8]}.`);
    }

    return {
        identity: buildIdentityFromParts(
            {
                a: Number(payloads[4]),
                b: Number(payloads[5]),
                c: Number(payloads[6]),
                d: Number(payloads[7])
            },
            playerId
        ),
        deliveryId
    };
}
