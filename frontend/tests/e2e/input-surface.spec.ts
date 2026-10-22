import {expect,test,type Page} from '@playwright/test';
import {mockUser,setupCoreMocks,setupTopologyMocks} from './helpers/api-mocks';

async function openProfile(page:Page,theme:'light'|'dark') {
 await setupCoreMocks(page,'Maintenance window tonight');
 await setupTopologyMocks(page);
 await page.route('**/api/v1/auth/me',route=>route.fulfill({json:{...mockUser,display_name:'Test User',email:'user@example.com',avatar_data:null,auth_source:'local',entity_colors_enabled:true}}));
 await page.route('**/api/v1/api-keys',route=>route.fulfill({json:[]}));
 await page.addInitScript(selected=>window.localStorage.setItem('netmap.theme',selected),theme);
 await page.goto('/profile');
 await page.locator('.profile-layout').waitFor({state:'visible'});
}

function resolve(page:Page,token:string) {
 return page.evaluate(name=>{const probe=document.createElement('span');probe.style.background=`var(${name})`;document.body.append(probe);const value=getComputedStyle(probe).backgroundColor;probe.remove();return value;},token);
}

test('light-mode inputs and popup sections use the softened near-white surface',async({page})=>{
 await openProfile(page,'light');
 for(const token of ['--nm-input-surface','--nm-modal-input','--nm-popup-section-bg']) expect(await resolve(page,token)).toBe('rgb(254, 254, 254)');
 const backgrounds=await page.evaluate(()=>['profile-input','mon-port-input','mon-ports-input','ipam-form-input','rbac-new-group-input','ep-trigger','ep-search'].map(name=>{
  const el=document.createElement(name.startsWith('ep-')?'button':'input');el.className=name;document.body.append(el);const value=getComputedStyle(el).backgroundColor;el.remove();return `${name} ${value}`;
 }));
 for(const line of backgrounds) expect(line).toMatch(/ rgb\(254, 254, 254\)$/);
});

test('dark-mode inputs keep their dark surfaces',async({page})=>{
 await openProfile(page,'dark');
 expect(await resolve(page,'--nm-modal-input')).toBe(await resolve(page,'--nm-shell'));
 expect(await resolve(page,'--nm-popup-section-bg')).toBe('rgb(22, 32, 51)');
});
