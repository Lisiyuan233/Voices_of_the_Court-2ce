import { parseBattleReportCampaignIdentityPayload } from '../../src/main/battleReport/battleReportCampaignIdentity';

const validPayload = [
    'campaign',
    '14232',
    '2',
    '1',
    '482410107',
    '517715122',
    '478538309',
    '350550288',
    '302743009'
];

describe('parseBattleReportCampaignIdentityPayload', () => {
    it('uses the campaign token emitted in the battle-report block', () => {
        expect(parseBattleReportCampaignIdentityPayload(validPayload, '14232')).toEqual({
            identity: expect.objectContaining({
                campaignId: '482410107-517715122-478538309-350550288',
                playerId: '14232',
                protocolSchema: 2,
                campaignSchema: 1
            }),
            deliveryId: 302743009
        });
    });

    it('rejects a campaign line that belongs to another player or delivery', () => {
        expect(() => parseBattleReportCampaignIdentityPayload(validPayload, '47866')).toThrow(
            'Battle report player mismatch'
        );
        expect(() => parseBattleReportCampaignIdentityPayload(
            [...validPayload.slice(0, 8), '0'],
            '14232'
        )).toThrow('invalid delivery id');
    });

    it('fails closed for missing or unsupported V2 campaign data', () => {
        expect(() => parseBattleReportCampaignIdentityPayload(undefined, '14232')).toThrow(
            'missing its V2 campaign identity'
        );
        expect(() => parseBattleReportCampaignIdentityPayload(
            [...validPayload.slice(0, 2), '3', ...validPayload.slice(3)],
            '14232'
        )).toThrow('Unsupported battle report protocol schema');
    });
});
