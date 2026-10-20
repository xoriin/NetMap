import {expect,test} from '@playwright/test';
import {setupExternalIps,mockAddress} from './helpers/external-ip';
import {mockDevice} from './helpers/api-mocks';

for (const theme of ['light','dark'] as const) {
 test(`Inventory details clear when changing subviews in ${theme}`,async({page})=>{
  await setupExternalIps(page,{theme,devices:[mockDevice({id:7,hostname:'Public server'})],addresses:[mockAddress({device_id:7})]});
  await page.goto('/inventory#devices');
  await page.getByRole('button',{name:'Open Public server details'}).click();
  await expect(page.getByRole('complementary',{name:'Device overview'})).toBeVisible();
  await page.getByRole('link',{name:'Cloud assets',exact:true}).click();
  await expect(page.locator('.inventory-device-sidebar')).toHaveCount(0);
  await page.getByRole('button',{name:'Open Public server details'}).click();
  await page.getByRole('button',{name:'Open linked device'}).click();
  await expect(page.getByRole('complementary',{name:'Device overview'})).toBeVisible();
  await page.goBack();
  await expect(page.locator('.inventory-device-sidebar')).toHaveCount(0);
  await page.goForward();
  await expect(page.locator('.inventory-device-sidebar')).toHaveCount(0);
 });
}
