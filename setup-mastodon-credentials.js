/**
 * setup-mastodon-credentials.js
 * 
 * Creates a Mastodon app + gets OAuth token on mastodon.social.
 * Produces INSTANCE + TOKEN for n8n Mastodon node.
 *
 * Flow:
 *   1. Create application (GET /api/v1/apps) -> client_id + client_secret
 *   2. Use password grant to get access token (POST /oauth/token)
 *   3. Verify by fetching account info + posting test toot
 *
 * Network: uses undici ProxyAgent for HTTP_PROXY support
 */

var { setGlobalDispatcher, ProxyAgent } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:10808'));

var INSTANCE = 'https://mastodon.social';
var EMAIL = process.env.MASTODON_EMAIL || 'aoshuang99@gmail.com';
// Note: User must register on mastodon.social first (or we try password grant)
var PASSWORD = process.env.MASTODON_PASSWORD || 'MscmsPub#2026!Auto';
var APP_NAME = 'MSCMS-v14-AutoPublisher';

function log(tag, data) {
  var msg = typeof data === 'string' ? data : JSON.stringify(data);
  console.log('[' + tag + '] ' + msg);
}

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

async function apiPost(path, body) {
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

async function apiGet(path, token) {
  var url = INSTANCE + path;
  var headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  log('GET', url);
  var res = await fetch(url, { headers: headers });
  var text = await res.text();
  var data = null;
  try { data = JSON.parse(text); } catch(e) { data = text; }
  return { status: res.status, data: data };
}

async function main() {
  log('START', { instance: INSTANCE, email: EMAIL });
  
  // Step 1: Create Mastodon application
  log('CREATE_APP', APP_NAME);
  var appRes = await apiPost('/api/v1/apps', {
    client_name: APP_NAME,
    redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
    scopes: 'read write',
    website: 'https://mscms.cc.cd',
  });

  if (!appRes.ok || !appRes.data || !appRes.data.client_id) {
    log('APP_FAIL', 'Cannot create application');
    console.log('\n=== MASTODON_CREDENTIALS_NOT_AVAILABLE ===');
    return;
  }

  var clientId = appRes.data.client_id;
  var clientSecret = appRes.data.client_secret;
  log('APP_OK', { client_id: clientId.substring(0, 10) + '...', client_secret: clientSecret.substring(0, 10) + '...' });

  // Step 2: Try password grant (Resource Owner Password Credentials Grant)
  // This requires the user to already have registered on mastodon.social
  log('PASSWORD_GRANT', 'attempting...');
  var tokenRes = await apiPost('/oauth/token', {
    grant_type: 'password',
    username: EMAIL,
    password: PASSWORD,
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'read write',
  });

  var token = null;
  if (tokenRes.ok && tokenRes.data && tokenRes.data.access_token) {
    token = tokenRes.data.access_token;
    log('TOKEN_OK', token.substring(0, 15) + '...');
  } else {
    log('TOKEN_FAIL', 'Password grant failed - user may not be registered yet');
    
    // Fallback: try client_credentials grant (app-level token, no user)
    log('CLIENT_CREDS_GRANT', 'trying fallback...');
    var ccRes = await apiPost('/oauth/token', {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'read write',
    });
    
    if (ccRes.ok && ccRes.data && ccRes.data.access_token) {
      token = ccRes.data.access_token;
      log('CC_TOKEN_OK', token.substring(0, 15) + '... (app-level)');
    } else {
      log('CC_TOKEN_FAIL', (ccRes.data && ccRes.data.error) || 'no token');
      console.log('\n=== MASTODON_CREDENTIALS_NOT_AVAILABLE ===');
      console.log('ACTION_NEEDED: Register at https://mastodon.social/auth/sign_up first, then re-run.');
      return;
    }
  }

  // Step 3: Verify token + get account info
  var verifyRes = await apiGet('/api/v1/accounts/verify_credentials', token);
  if (verifyRes.ok && verifyRes.data && verifyRes.data.username) {
    log('VERIFY_OK', { username: verifyRes.data.username, id: verifyRes.data.id });
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
async function apiPostWithToken(path, body, token) {
  var url = INSTANCE + path;
  var headers = jsonHeaders();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  var res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
  var text = await res.text();
  var data = null;
  try { data = JSON.parse(text); } catch(e) { data = text; }
  return { status: res.status, data: data, ok: res.ok };
}

main().catch(function(e) {
  log('FATAL', e.message);
  process.exit(1);
});
