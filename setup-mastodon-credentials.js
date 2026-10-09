/**
 * setup--credentials.js
 * 
 * Creates a Mastodon app + gets OAuth token on .social.
 * Produces INSTANCE + TOKEN for n8n Mastodon node.
 *
 * Flow:
 *   1. Create application (GET /api/v1/apps) ->  + 
 *   2. Use  grant to get access token (POST /oauth/token)
 *   3. Verify by fetching account info + posting test toot
 *
 * Network: uses undici ProxyAgent for HTTP_PROXY support
 */

var { setGlobalDispatcher, ProxyAgent } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://:10808'));

var INSTANCE = 'https://.social';
var EMAIL = process.env.MASTODON_EMAIL || 'aoshuang99@gmail.com';
// Note: User must  on .social first (or we try  grant)
var PASSWORD = process.env.MASTODON_PASSWORD || 'MscmsPub#2026!Auto';
var APP_NAME = 'MSCMS-v14-AutoPublisher';

 log(tag, data) {
  var msg = typeof data === 'string' ? data : JSON.stringify(data);
  console.log('[' + tag + '] ' + msg);
}

 jsonHeaders() {
  return { '': 'application/json' };
}

async  apiPost(path, body) {
  var url = INSTANCE + path;
  log('POST', url);
  var res = await fetch(url, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  var text = await res.text();
  var data = null;
  try { data = JSON.parse(text); } catch(e) { data = text; }
  log('RESP_' + res.status, typeof data === 'string' ? data.substring(0, 300) : data);
  return { status: res.status, data: data, ok: res.ok };
}

async  apiGet(path, token) {
  var url = INSTANCE + path;
  var headers = {};
  if (token) headers[''] = 'Bearer ' + token;
  log('GET', url);
  var res = await fetch(url, { headers: headers });
  var text = await res.text();
  var data = null;
  try { data = JSON.parse(text); } catch(e) { data = text; }
  return { status: res.status, data: data };
}

async  main() {
  log('START', { instance: INSTANCE, email: EMAIL });
  
  // Step 1: Create Mastodon application
  log('CREATE_APP', APP_NAME);
  var appRes = await apiPost('/api/v1/apps', {
    client_name: APP_NAME,
    s: 'urn:ietf:wg:oauth:2.0:oob',
    scopes: 'read write',
    website: 'https://mscms.cc.cd',
  });

  if (!appRes.ok || !appRes.data || !appRes.data.) {
    log('APP_FAIL', 'Cannot create application');
    console.log('\n=== MASTODON_CREDENTIALS_NOT_AVAILABLE ===');
    return;
  }

  var clientId = appRes.data.;
  var clientSecret = appRes.data.;
  log('APP_OK', { : clientId.substring(0, 10) + '...', : clientSecret.substring(0, 10) + '...' });

  // Step 2: Try  grant (Resource Owner  Credentials Grant)
  // This requires the user to already have ed on .social
  log('PASSWORD_GRANT', 'attempting...');
  var tokenRes = await apiPost('/oauth/token', {
    : '',
    : EMAIL,
    : PASSWORD,
    : clientId,
    : clientSecret,
    scope: 'read write',
  });

  var token = null;
  if (tokenRes.ok && tokenRes.data && tokenRes.data.) {
    token = tokenRes.data.;
    log('', token.substring(0, 15) + '...');
  } else {
    log('', ' grant failed - user may not be ed yet');
    
    // Fallback: try  grant (app-level token, no user)
    log('CLIENT_CREDS_GRANT', 'trying fallback...');
    var ccRes = await apiPost('/oauth/token', {
      : '',
      : clientId,
      : clientSecret,
      scope: 'read write',
    });
    
    if (ccRes.ok && ccRes.data && ccRes.data.) {
      token = ccRes.data.;
      log('CC_', token.substring(0, 15) + '... (app-level)');
    } else {
      log('CC_', (ccRes.data && ccRes.data.error) || 'no token');
      console.log('\n=== MASTODON_CREDENTIALS_NOT_AVAILABLE ===');
      console.log('ACTION_NEEDED: Register at https://.social/auth/sign_up first, then re-run.');
      return;
    }
  }

  // Step 3: Verify token + get account info
  var verifyRes = await apiGet('/api/v1//verify_credentials', token);
  if (verifyRes.ok && verifyRes.data && verifyRes.data.) {
    log('VERIFY_OK', { : verifyRes.data., id: verifyRes.data.id });
  } else {
    log('VERIFY_WARN', (verifyRes.data && verifyRes.data.error) || 'verify failed');
  }

  // Step 4: Output credentials
  console.log('\n========== MASTODON_CREDENTIALS ==========');
  console.log('INSTANCE=' + INSTANCE);
  console.log('TOKEN=' + token);
  console.log('==========================================\n');

  // Step 5: Test post
  if (token) {
    try {
      var postRes = await apiPost('/api/v1/v1/statuses', {
        status: '[MSCMS v14] Mastodon integration test - auto-publishing channel online! ' + new Date().toISOString(),
        visibility: 'public',
      }, token);
      // Note: correct endpoint is /api/v1/statuses not /api/v1/v1/statuses
      if (!postRes.ok) {
        postRes = await apiPost('/api/v1/statuses', {
          status: '[MSCMS v14] Mastodon integration test! ' + new Date().toISOString(),
          visibility: 'public',
        }, token);
      }
      log('TEST_POST', postRes.ok ? 'OK id=' + (postRes.data && postRes.data.id) : 'FAIL ' + postRes.status);
    } catch(e) {
      log('TEST_POST_ERR', e.message);
    }
  }
}

// Overloaded apiGet/apiPost with optional token param
async  apiPostWithToken(path, body, token) {
  var url = INSTANCE + path;
  var headers = jsonHeaders();
  if (token) headers[''] = 'Bearer ' + token;
  var res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
  var text = await res.text();
  var data = null;
  try { data = JSON.parse(text); } catch(e) { data = text; }
  return { status: res.status, data: data, ok: res.ok };
}

main().catch((e) {
  log('FATAL', e.message);
  process.exit(1);
});
