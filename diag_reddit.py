"""Diagnose reddit form DOM and test React injection."""
import asyncio, random, json
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)
        ctx = await browser.new_context(locale='en-US')
        page = await ctx.new_page()
        await page.goto('https://www.reddit.com//', wait_until='domcontentloaded')
        await asyncio.sleep(6)
        
        email = f'test{random.randint(1000,9999)}@gmail.com'
        print(f'Email: {email}')
        
        # Inject email via React native value setter
        result = await page.evaluate("""
            (email) => {
                const input = document.querySelector('"email"]');
                if (!input) return {error: 'no-input'};
                
                const setter = Object.getOwnPropertyDescriptor(
                    HTMLInputElement.prototype, 'value'
                ).set;
                setter.call(input, email);
                input.dispatchEvent(new Event('input', {bubbles: true}));
                input.dispatchEvent(new Event('change', {bubbles: true}));
                input.focus();
                input.blur();
                
                const btn = document.querySelector('button');
                return {
                    value: input.value,
                    btnDisabled: btn ? btn.disabled : 'no-btn',
                    btnText: btn ? btn.textContent.trim() : 'no-btn'
                };
            }
        """, email)
        print(f'Inject result: {json.dumps(result)}')
        
        await asyncio.sleep(2)
        
        # Check state
        state = await page.evaluate("""
            () => {
                const inputs = {};
                ['email','',''].forEach(n => {
                    const e = document.querySelector('"' + n + '"]');
                    if (e) inputs[n] = {visible: e.offsetParent !== null, val: e.value};
                });
                const btns = [];
                'button').forEach(b => {
                    if (b.offsetParent !== null)
                        btns.push({text: b.textContent.trim().substring(0,50), disabled: b.disabled});
                });
                return {inputs, btns};
            }
        """)
        print(f'\nState: {json.dumps(state, indent=2, ensure_ascii=False)}')
        
        # Click first enabled button
        enabled = [b for b in state['btns'] if not b['disabled']]
        print(f'\nEnabled: {enabled}')
        
        if enabled:
            print(f'Clicking: {enabled[0]["text"]}')
            await page.locator('button:not([disabled])').first.click()
            await asyncio.sleep(5)
            print(f'URL: {page.url}')
            
            state2 = await page.evaluate("""
                () => {
                    const inputs = {};
                    ['email','',''].forEach(n => {
                        const e = document.querySelector('"' + n + '"]');
                        if (e) inputs[n] = {visible: e.offsetParent !== null, val: e.value};
                    });
                    return inputs;
                }
            """)
            print(f'After click: {json.dumps(state2, indent=2, ensure_ascii=False)}')
        
        await browser.close()

asyncio.run(main())
