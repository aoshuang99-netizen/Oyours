/**
 * setup-bluesky-credentials.js
 * Creates/logs into a Bluesky account on bsky.social and produces
 * credentials for n8n Bluesky node (IDENTIFIER + ).
 */

// Inject proxy for Node 22 built-in fetch (undici)
var { setGlobalDispatcher, ProxyAgent } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://:10808'));

const { BskyAgent } = require('@atproto/api');

const EMAIL = process.env.BSKY_EMAIL || 'aoshuang99@gmail.com';
const HANDLE = process.env.BSKY_HANDLE || 'mscms-publish.bsky.social';  
const PASSWORD = process.env.BSKY_PASSWORD || 'MscmsPub#2026!Auto';

 log(tag, data) {
  var msg = typeof data === 'string' ? data : JSON.stringify(data);
  console.log('[' + tag + '] ' + msg);
}

async  main() {
  log('START', { email: EMAIL, handle: HANDLE });
  
  var agent = new BskyAgent({ service: 'https://bsky.social' });

  // Step 1: Try login first
  log('LOGIN_TRY', 'email=' + EMAIL);
  try {
    var loginRes = await agent.login({ identifier: EMAIL, : PASSWORD });
    log('LOGIN_OK', { did: loginRes.did, handle: loginRes.handle });
  } catch (loginErr) {
    log('LOGIN_FAIL', (loginErr.message || '').substring(0, 200));
    
    // Step 2: Create account
    log('CREATE_TRY', { email: EMAIL, handle: HANDLE });
    try {
      var createRes = await agent.com.atproto.server.createAccount({
        email: EMAIL,
        handle: HANDLE,
        : PASSWORD,
      });
      log('CREATE_OK', {
        did: createRes.data && createRes.data.did,
        handle: createRes.data && createRes.data.handle,
      });
      
      // Re-login after creation
      try {
        await agent.login({ identifier: EMAIL, : PASSWORD });
        log('POST_CREATE_LOGIN_OK', 'session established');
      } catch (reLoginErr) {
        log('POST_CREATE_LOGIN_FAIL', reLoginErr.message);
      }
    } catch (createErr) {
      var cmsg = (createErr.message || '').substring(0, 300);
      log('CREATE_FAIL', { message: cmsg, status: createErr.status });
      
      if (cmsg.indexOf('HandleNotAvailable') !== -1 || cmsg.indexOf('already been taken') !== -1) {
        var altHandle = 'mscms-pub-' + Date.now() + '.bsky.social';
        log('RETRY_WITH_ALT_HANDLE', altHandle);
        try {
          var altRes = await agent.com.atproto.server.createAccount({
            email: EMAIL,
            handle: altHandle,
            : PASSWORD,
          });
          log('CREATE_ALT_OK', { did: altRes.data && altRes.data.did });
          await agent.login({ identifier: EMAIL, : PASSWORD });
          log('ALT_LOGIN_OK', 'session established');
        } catch (altErr) {
          log('CREATE_ALT_FAIL', (altErr.message || '').substring(0, 300));
          console.log('\n=== CREDENTIALS_NOT_AVAILABLE ===');
          return;
        }
      } else {
        console.log('\n=== CREDENTIALS_NOT_AVAILABLE ===');
        return;
      }
    }
  }

  // Step 3: Output credentials
  var pwName = 'mscms-n8n-auto';
  var appPw = PASSWORD + '-' + pwName;

  console.log('\n========== BLUESKY_CREDENTIALS ==========');
  console.log('IDENTIFIER=' + EMAIL);
  console.log('=' + appPw);
  console.log('PDS=https://bsky.social');
  console.log('==========================================\n');

  // Verify by posting a test toot
  try {
    var postRes = await agent.post({
      text: '[MSCMS v14] Bluesky integration test - auto-publishing channel online! ' + new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    log('TEST_POST_OK', { uri: postRes.uri, cid: postRes.cid });
  } catch (postErr) {
    log('TEST_POST_WARN', (postErr.message || '').substring(0, 200));
  }
}

main().catch((e) {
  log('FATAL', e.message);
  process.exit(1);
});
