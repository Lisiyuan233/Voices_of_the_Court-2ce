/**
 * R2 (pending-reply delivery isolation): the delivery gate must only let a
 * reply through when its immutable campaign identity and player match the
 * game context the delivery would write into. Unknown identity on either
 * side holds the reply pending instead of consuming the current campaign's
 * letter slot.
 */
import { evaluateReplyDeliveryGate } from '../../../src/main/letter/letterDeliveryGate';

const CAMPAIGN_A = '111111111-222222222-333333333-444444444';
const CAMPAIGN_B = '999999999-888888888-777777777-666666666';
const PLAYER_ID = '32769';

describe('evaluateReplyDeliveryGate (R2)', () => {
    const deliverableReply = {
        recipientId: PLAYER_ID,
        campaignId: CAMPAIGN_A
    };

    it('delivers when campaign and player match the current game', () => {
        expect(evaluateReplyDeliveryGate(deliverableReply, { campaignId: CAMPAIGN_A }, PLAYER_ID))
            .toEqual({ deliverable: true });
    });

    it('holds the reply when it was generated in another campaign', () => {
        expect(evaluateReplyDeliveryGate(deliverableReply, { campaignId: CAMPAIGN_B }, PLAYER_ID))
            .toEqual({ deliverable: false, reason: 'campaign_mismatch' });
    });

    it('holds the reply when the current game carries no campaign identity', () => {
        expect(evaluateReplyDeliveryGate(deliverableReply, undefined, PLAYER_ID))
            .toEqual({ deliverable: false, reason: 'current_campaign_unknown' });
    });

    it('holds legacy records without a campaign stamp', () => {
        expect(evaluateReplyDeliveryGate({ recipientId: PLAYER_ID }, { campaignId: CAMPAIGN_A }, PLAYER_ID))
            .toEqual({ deliverable: false, reason: 'reply_campaign_unknown' });
    });

    it('holds the reply when the current player differs', () => {
        expect(evaluateReplyDeliveryGate(deliverableReply, { campaignId: CAMPAIGN_A }, '12345'))
            .toEqual({ deliverable: false, reason: 'player_mismatch' });
    });
});
