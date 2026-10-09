import sys, requests, json
sys.path.insert(0, '.')
# test mail.tm
try:
    from mailtm import MailTM
    m = MailTM()
    print('mail.tm OK:', m.address)
except Exception as e:
    print('mail.tm FAIL:', repr(e)[:200])

# test guerrillamail via direct api
try:
    r = requests.get('https://api.guerrillamail.com/ajax.php', params={'f':'get_email_address','ip':'','agent':'Mozilla/5.0'}, timeout=10, proxies={'http':'http://:10808','https':'http://:10808'})
    print('guerrillamail:', r.json().get('email_addr'))
except Exception as e:
    print('guerrillamail FAIL:', repr(e)[:200])
