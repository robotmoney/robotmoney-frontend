import { describe, test, expect } from 'bun:test';
import { filterResearchTakes, filterSessionDates, holdingsMarkup, portfolioRows, researchRecord, researchTakeList, stanceTallyMarkup } from '../../public/assets/js/app/components/subject-research.js';
import { withSubjectStress } from '../../public/prototypes/subjects/stress.js';

describe('portfolio research semantics', () => {
  test('unknown book value never implies zero exposure; known zero remains zero', () => {
    const rows = [{ token: 'USDC', value_usd: 0 }];
    expect(portfolioRows({ positions: rows })[0].share).toBe(null);
    expect(portfolioRows({ totalValueUsd: 100, positions: rows })[0].share).toBe(0);
    expect(holdingsMarkup({ positions: rows })).toContain('Not reported');
  });
  test('every position can be disclosed, with long or untrusted labels escaped', () => {
    const positions = Array.from({ length: 14 }, (_, i) => ({ token: `<asset-${i}>`, chain: 'base', value_usd: i }));
    expect((holdingsMarkup({ positions }).match(/scope="row"/g) || []).length).toBe(8);
    const full = holdingsMarkup({ positions }, true);
    expect((full.match(/scope="row"/g) || []).length).toBe(14);
    expect(full).toContain('&lt;asset-13&gt;');
    expect(full).not.toContain('<asset-13>');
  });
  test('a tie is not a majority and unknown stances remain explicit', () => {
    const row = { takeRows: [{ stance: 'cautious' }, { stance: 'constructive' }] };
    expect(researchRecord.researchView(row)).toBe('Mixed views');
    expect(stanceTallyMarkup({ takeRows: [{ stance: 'unrecognised' }] })).toContain('unrecognised');
  });
  test('aggregate placeholder actions are not presented as authored decisions', () => {
    const row = { swarmRecommendation: { quorum: { submitted: 3 }, actions: [{ token: 'USDC', action: 'rotate' }], rationale: 'Aggregate template' } };
    expect(researchRecord.researchActions(row)).toEqual([]);
    expect(researchRecord.researchRationale(row)).toBe('');
  });
});

describe('progressive disclosure at scale', () => {
  const fixture = withSubjectStress({ routes: {} });
  const detail = fixture.routes['/api/swarm/sessions/00000000-0000-4000-8000-000000000095'];
  test('date search covers the provided index, not only the rendered page', () => {
    const index = fixture.routes['/api/swarm/sessions'].sessions;
    expect(index.length).toBe(97);
    expect(filterSessionDates(index, 'June')).toHaveLength(35);
    expect(filterSessionDates(index, '2026-05-01')).toHaveLength(2);
    expect(filterSessionDates(index, '%')).toHaveLength(0);
  });
  test('take search reaches long bodies beyond the initial six; all stances can be filtered', () => {
    expect(detail.takes).toHaveLength(18);
    expect(filterResearchTakes(detail.takes, 'Risk and Liquidity')).toHaveLength(1);
    expect(filterResearchTakes(detail.takes, '<script>')).toHaveLength(0);
    expect(filterResearchTakes(detail.takes, '', 'cautious').every(t => t.stance === 'cautious')).toBe(true);
  });
  test('a deep link reveals a take beyond the initial fold', () => {
    const list = { ...researchTakeList(), takes: detail.takes, $nextTick() {} };
    expect(list.visibleResearchTakes()).toHaveLength(6);
    list.takeQuery = 'no match';
    list.revealResearchTake(detail.takes[15]);
    expect(list.takeQuery).toBe('');
    expect(list.visibleResearchTakes()).toContain(detail.takes[15]);
  });
});
