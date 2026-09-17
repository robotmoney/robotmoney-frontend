// Keep the component catalogue's behavior suite in the required unit tier.
import '../../../frontend/public/prototypes/research/research.test.js';
import { test, expect } from 'bun:test';
import { adapt } from '../../../frontend/public/assets/js/app/research/data.js';
import { sessionPage, subjectPage, sessionPath } from '../../../frontend/public/assets/js/app/research/pages.js';
import { sleeves } from '../../../frontend/public/assets/js/app/components/research.js';
import { viewFor } from '../../../frontend/public/assets/js/app/routes.js';
const weights = sleeves.map((s, i) => ({ bucket: s.key, weight: [.95,.05,0,0][i] }));
const session = { id: '11111111-1111-4111-8111-111111111111', date: '2026-09-17', subjectId: 'robotmoney-allocation', state: 'collecting', generatedAt: '2026-09-17T14:00:00Z', swarmRecommendation: { weights, rationale: '<script>bad()</script>', consensus: [], disagreements: [] } };

test('live envelope preserves signature status, stable identity and absent reference', () => {
  const record = adapt({ session, takes: [{ id: 't1', memberId:'immutable',memberHandle:'renamed-analyst', memberName:'Analyst',weights,verified:true,archival:false,body:'My view' }] }, null, {}, 'live');
  expect(record.weights).toEqual([95,5,0,0]);
  expect(record.reference).toBeNull();
  expect(record.takes[0].weights).toEqual([95,5,0,0]);
  expect(sessionPath(record)).toBe(`/swarm/sessions/${session.id}`);
  const html = sessionPage(record, [record]);
  expect(html).toContain('collecting session');
  expect(html).toContain('Signature verified');
  expect(html).toContain('/swarm/members/renamed-analyst');
  expect(html).toContain('/swarm/takes/t1');
  expect(html).not.toContain('Archived · unsigned');
  expect(html).not.toContain('Local design preview');
  expect(html).not.toContain('<script>bad()');
  expect(html).toContain('14:00 UTC');
});

test('missing, unsigned archive and failed signatures stay distinct in the API view', () => {
  const record = adapt({session, takes:[{id:'a',memberId:'a',archival:true},{id:'b',memberId:'b',verified:false}]}, null, {}, 'live');
  const html = sessionPage(record,[record]);
  expect(html).toContain('Archived · unsigned');
  expect(html).toContain('Signature not verified');
  expect(html).not.toContain('Signature verified');
  expect(record.takes.every(t=>t.weights===null)).toBe(true);
});

test('production history uses each list row reference and its recorded take count', () => {
  const row = { ...session, state:'published',takeCount:10,referenceAllocation:{asof:'2026-09-01',buckets:sleeves.map((s,i)=>({id:s.key,target_weight:[.9,.1,0,0][i]}))} };
  const record = adapt(row,null,{},'live');
  expect(record.reference).toEqual([90,10,0,0]);
  const html = subjectPage([record],'live');
  expect(html).toContain('10 analyst takes');
  expect(html).toContain('+5 pp');
  expect(html).toContain('−5 pp');
  expect(html).not.toContain('data=stress');
  expect(html).not.toContain('June 2026');
});

test('only Allocation subject and dated session routes select the new view', () => {
  expect(viewFor('/swarm/subjects/robotmoney-allocation')).toBe('/views/swarm/allocation-research.html');
  expect(viewFor('/swarm/2026-06-24/robotmoney-allocation')).toBe('/views/swarm/allocation-research.html');
  expect(viewFor('/swarm/subjects/robotmoney-vault')).toBe('/views/swarm/subject.html');
  expect(viewFor('/swarm/2026-06-24/robotmoney-vault')).toBe('/views/swarm/session.html');
});

test('an unfinished recommendation does not claim that an available reference is missing', () => {
  const record = adapt({ ...session, swarmRecommendation:null }, { allocation:{asof:'2026-09-01',buckets:sleeves.map((s,i)=>({id:s.key,target_weight:[.95,.05,0,0][i]}))} }, {}, 'live');
  const html = sessionPage(record,[record]);
  expect(html).toContain('Recommendation pending');
  expect(html).toContain('policy dated 1 Sep 2026');
});
