import sys
sys.path.insert(0, 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19')
from _capsolver import capsolver_solve

sitekey = '6LeYrbYqAAAAAF9Hyb1luPFtcSylK688Hk22La0B'
print('尝试 V2...', flush=True)
tok = capsolver_solve('RecaptchaV2TaskProxyless', 'https://www.tumblr.com/', sitekey, extra=None)
if tok:
    print('TOKEN:' + tok)
else:
    print('V2_FAIL', flush=True)
    print('尝试 V3...', flush=True)
    tok3 = capsolver_solve('', 'https://www.tumblr.com/', sitekey, extra={'pageAction': ''})
    if tok3:
        print('TOKEN:' + tok3)
    else:
        print('ALL_FAIL')
