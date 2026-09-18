import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Local frontend review. Saved records and synthetic design fixtures only.
// Run against prototypes/vaults/preview.mjs, never a production API.
const capture = process.env.REVIEW_CAPTURE;
const pages = [
  ['allocation', '/allocation?fixture=devnet', 'Asset Allocation'],
  ['vault', '/vault/rmusdc?fixture=devnet', 'rmUSDC'],
  ['allocation-research', '/swarm/subjects/robotmoney-allocation', 'RobotMoney Allocation'],
  ['allocation-session', '/swarm/2026-06-24/robotmoney-allocation', ''],
  ['portfolio', '/swarm/subjects/robotmoney-vault', 'Robot Money Vault'],
  ['portfolio-session', '/swarm/2026-06-22/robotmoney-vault', ''],
  ['swarm', '/swarm', ''],
];
for (const width of [1440, 390]) {
  for (const [slug, route] of pages) {
    test(`${slug} at ${width}px renders a readable page`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({width, height:1000});
      await page.goto(route);
      await expect(page.locator('main h1').first()).toBeVisible();
      await page.waitForFunction(() => !document.querySelector('main')?.textContent?.includes('Loading allocation…') || [...document.querySelectorAll('main h2')].some(e => e.getBoundingClientRect().height > 0));
      await page.evaluate(() => document.fonts.ready);
      // Wait for the data-dependent sections rather than a network-idle heuristic.
      if (slug === 'vault') await expect(page.locator('.vv-stats strong').first()).toHaveText('$72,000.00');
      if (slug === 'allocation') await expect(page.locator('.vv-overview tbody tr')).toHaveCount(4);
      if (slug === 'portfolio') await expect(page.locator('.pr-verdict').first()).toBeVisible();
      if (capture) {
        const dir=resolve('/tmp/rm-design-review',capture); await mkdir(dir,{recursive:true});
        await page.screenshot({path:resolve(dir,`${slug}-${width}.png`),animations:'disabled'});
        await page.screenshot({path:resolve(dir,`${slug}-${width}-full.png`),fullPage:true,animations:'disabled'});
      }
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

for (const width of [1440, 390]) {
  test(`vault interaction and full research journey at ${width}px`, async ({ page }) => {
    const errors: string[]=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.setViewportSize({width,height:1000});
    await page.goto('/allocation?fixture=devnet');
    await page.getByRole('link',{name:/rmUSDC/}).first().click();
    await expect(page.locator('.vv-stats strong').first()).toHaveText('$72,000.00');
    const crumb=page.getByRole('navigation',{name:'Breadcrumb'});
    await expect(crumb).toBeInViewport();
    expect((await crumb.boundingBox())!.y).toBeGreaterThan(80);
    await page.getByRole('navigation',{name:'Vault sections'}).getByRole('link',{name:'Holdings',exact:true}).click();
    await page.locator('.vp-band button').first().focus();
    await expect(page.locator('.vp-band-reading')).toContainText('38.89%');
    if(capture) await page.locator('#holdings').screenshot({path:`/tmp/rm-design-review/${capture}/holdings-${width}.png`});
    await page.locator('.vp-position summary').first().click();
    await expect(page.locator('.vp-position[open]')).toHaveCount(1);
    await page.getByRole('navigation',{name:'Vault sections'}).getByRole('link',{name:'Allocation',exact:true}).click();
    const heights=await page.locator('.vv-layer .vv-track i').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height));
    expect(heights).toEqual([6,6,6]);
    const tip=page.getByRole('button',{name:'About recommended',exact:true});
    await tip.click(); await expect(tip).toHaveAttribute('aria-expanded','true');
    const box=await page.getByRole('tooltip').filter({hasText:'latest published swarm'}).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x+box!.width).toBeLessThanOrEqual(width);
    await tip.press('Escape'); await expect(tip).toHaveAttribute('aria-expanded','false');
    await page.getByRole('navigation',{name:'Vault sections'}).getByRole('link',{name:'History',exact:true}).click();
    const slider=page.getByRole('slider',{name:'Historical observation'});
    await slider.focus(); await slider.press('ArrowLeft');
    await expect(slider).toHaveAttribute('aria-valuenow','2');
    await expect(page.locator('.vv-history-reading strong')).toHaveText('$57,600.00');
    if(capture) await page.locator('#history').screenshot({path:`/tmp/rm-design-review/${capture}/history-${width}.png`});
    await page.getByRole('group',{name:'History metric'}).getByRole('button',{name:'Share price'}).click();
    await expect(page.locator('.vv-chart')).toContainText('No observations reported');
    await page.getByRole('link',{name:'Allocation research →',exact:true}).click();
    await expect(page.locator('h1')).toContainText(/Robot ?Money Allocation/);
    await page.getByRole('link',{name:/Read the .* session/}).first().click();
    await expect(page.getByRole('navigation',{name:'Session sections'})).toBeVisible();
    await page.getByRole('link',{name:'Allocation & vaults ↗',exact:true}).click();
    await expect(page.locator('.vv-overview tbody tr')).toHaveCount(4);
    expect(errors).toEqual([]);
  });

  for (const library of ['vaults','subjects']) {
    test(`${library} component library at ${width}px`,async ({page})=>{
      const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
      await page.setViewportSize({width,height:1000});
      await page.goto(`/prototypes/${library}/index.html`);
      await expect(page.getByRole('navigation',{name:'Component library'})).toBeVisible();
      expect(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
      if(library==='vaults') {
        await page.getByRole('button',{name:'Missing read'}).click();
        await expect(page.locator('.vv-layer-missing')).toHaveCount(4);
        await page.getByRole('button',{name:'No recommendation'}).click();
        await expect(page.locator('.vv-layer-missing')).toHaveCount(4);
        await page.locator('.vp-band button').first().focus();
        await expect(page.locator('.vp-band-reading')).toContainText('38.89%');
      }
      if(capture) await page.screenshot({path:`/tmp/rm-design-review/${capture}/catalogue-${library}-${width}.png`,fullPage:true});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}

test('large vault histories, positions and events stay bounded',async ({page})=>{
  await page.setViewportSize({width:390,height:1000});
  await page.goto('/vault/rmusdc?fixture=stress');
  await expect(page.locator('.vp-position')).toHaveCount(8);
  await page.getByRole('button',{name:'Show all 32 positions'}).click();
  await expect(page.locator('.vp-position')).toHaveCount(32);
  await page.getByRole('button',{name:'Show fewer positions'}).click();
  await page.getByRole('group',{name:'History period'}).getByRole('button',{name:'All',exact:true}).click();
  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuemax','180');
  await page.getByText('Historical observations',{exact:true}).click();
  const nav=page.getByRole('navigation',{name:'Historical observations'});
  await nav.getByRole('button',{name:'Next'}).click();
  await expect(nav).toContainText('11–20 of 180');
  const activity=page.getByRole('navigation',{name:'Activity pages'});
  await activity.getByRole('button',{name:'Next'}).click();
  await expect(activity).toContainText('7–12 of 120 events');
  expect(await page.locator('#activity .vv-event').count()).toBe(6);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(capture) await page.screenshot({path:`/tmp/rm-design-review/${capture}/vault-stress-390-full.png`,fullPage:true});
});

for (const route of ['/swarm/2026-06-24/robotmoney-allocation','/swarm/2026-06-17/robotmoney-vault']) {
  test(`large research roster is searchable: ${route}`,async ({page})=>{
    await page.goto(route+'?fixture=stress');
    await expect(page.locator('.rr-take')).toHaveCount(6);
    await expect(page.locator('.pr-takes-status')).toHaveText('6 of 18 matching takes');
    await page.getByRole('searchbox',{name:'Find a member or argument'}).fill('Preview Analyst 17');
    await expect(page.locator('.rr-take')).toHaveCount(1);
    await page.getByRole('button',{name:'Clear',exact:true}).click();
    await page.getByRole('button',{name:/Show more takes/}).click();
    await expect(page.locator('.rr-take')).toHaveCount(12);
  });
}

test('fixture choices persist through navigation without leaking between tabs',async ({context})=>{
  const synthetic=await context.newPage(), saved=await context.newPage();
  await synthetic.goto('/vault/rmusdc?fixture=devnet');
  await saved.goto('/vault/rmusdc?fixture=base');
  await expect(synthetic.locator('.vv-stats strong').first()).toHaveText('$72,000.00');
  await expect(saved.locator('.vv-identity')).toContainText('Base');
  await synthetic.reload();
  await expect(synthetic.locator('.vv-stats strong').first()).toHaveText('$72,000.00');
  await expect(saved.locator('.vv-identity')).not.toContainText('Test data');
});

for(const mode of ['empty','unreadable','no-receipt','stale','paused']) {
  test(`vault state: ${mode}`,async ({page})=>{
    const slug=mode==='unreadable'?'rmproto':'rmusdc';
    await page.goto(`/vault/${slug}?fixture=${mode}`);
    await expect(page.locator('.vv-stats')).toHaveAttribute('aria-busy','false');
    if(mode==='empty') { await expect(page.locator('.vp-position')).toHaveCount(0); await expect(page.locator('.vv-stats strong').first()).toHaveText('$0.00'); }
    if(mode==='unreadable') { await expect(page.locator('.vv-stats strong').first()).toHaveText('Not reported'); await expect(page.locator('.vv-layer-missing')).toHaveCount(1); }
    if(mode==='no-receipt') await expect(page.locator('.vv-layer-missing')).toHaveCount(1);
    if(mode==='stale') await expect(page.locator('.vv-meta').first()).toContainText('Stale');
    if(mode==='paused') await expect(page.locator('.vv-identity')).toContainText('Deposits paused');
  });
}

for(const slug of ['rmagent','rmproto','rmrwa']) {
  test(`${slug} preserves its own identity and allocation weights`, async ({page})=>{
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`/vault/${slug}?fixture=devnet`);
    await expect(page.locator('.vv-stats')).toHaveAttribute('aria-busy','false');
    await expect(page.locator('h1')).toHaveText({rmagent:'rmAGENT',rmproto:'rmPROTO',rmrwa:'rmRWA'}[slug]!);
    const colors=await page.locator('.vv-layer [data-mark="series"]').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).backgroundColor));
    expect(new Set(colors).size).toBe(1);
    expect(errors).toEqual([]);
  });
}

test('subject overview date search covers sessions beyond the first page',async ({page})=>{
  await page.goto('/swarm/subjects/robotmoney-vault?fixture=stress');
  await expect(page.locator('.pr-history__row')).toHaveCount(12);
  await page.locator('.pr-controls input[type="search"]').fill('2026-05-01');
  await page.locator('.pr-controls input[type="search"]').press('Enter');
  await expect(page.locator('.pr-history__row')).toHaveCount(1);
  await expect(page.locator('.pr-history__date')).toContainText('May 1');
  await page.locator('.pr-history__date').click();
  await expect(page.locator('.rr-take')).toHaveCount(6);
});

test('swarm invites participation before the research directory',async ({page})=>{
  await page.goto('/swarm');
  const join=page.getByRole('link',{name:'Join the swarm'});
  await expect(join).toBeInViewport();
  await expect(join).toHaveAttribute('href','/swarm/apply');
});

test('a failed overview does not silently substitute legacy totals',async ({page})=>{
  await page.route('**/api/dashboards/robotmoney-vaults?*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Unavailable"}'}));
  await page.goto('/vault/rmusdc?fixture=devnet');
  await expect(page.getByRole('status').filter({hasText:'Vault data is unavailable'})).toBeVisible();
  await expect(page.locator('.vv-layer .vv-reading-missing')).toHaveCount(3);
});

test('rendered vault charts follow the shared palette and numeric treatment',async ({page})=>{
  await page.goto('/vault/rmusdc?fixture=devnet');
  await expect(page.locator('.vp-position')).toHaveCount(4);
  const result=await page.locator('.vv-page').evaluate(root=>{
    const hues=new Set(['rgb(16, 185, 129)','rgb(0, 229, 255)','rgb(232, 166, 64)','rgb(126, 136, 158)','rgb(255, 122, 41)','rgb(95, 179, 161)','rgb(156, 255, 210)']);
    const visible=[...root.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().width>0 && e.getBoundingClientRect().height>0);
    return {
      invalidSeries:visible.filter(e=>e.matches('[data-mark="series"]')).filter(e=>!hues.has(e instanceof SVGElement ? getComputedStyle(e).fill : getComputedStyle(e).backgroundColor)).map(e=>e.outerHTML),
      cyanFigures:visible.filter(e=>!e.children.length && /\d/.test(e.textContent||'') && getComputedStyle(e).color==='rgb(0, 229, 255)').map(e=>e.textContent),
      effects:visible.filter(e=>getComputedStyle(e).backgroundImage.includes('gradient') || getComputedStyle(e).boxShadow!=='none').map(e=>e.className),
    };
  });
  expect(result).toEqual({invalidSeries:[],cyanFigures:[],effects:[]});
});
