/**
 * workbench/api-client.js — MSCMS v14 统一前端数据访问层
 * 设计依据：dev_design_tasks.html §3 数据交互契约（apiClient 约定）
 * - 分页：?page&pageSize
 * - 投影：?fields=a,b,c（仅返回指定字段，降低大响应体积，目标  80KB→<12KB）
 * - 错误：统一 {status, code, error, detail}，非 2xx 抛带 status 的 Error
 * - 幂等：写操作可选 Idempotency-Key，防重复提交（配合后端去重）
 * - 零依赖、UMD 风格，挂全局 MSCMS.api，供 workbench.html 以 <script> 引入
 * 注意：仅通过相对路径访问同源 API，天然走 Cloudflare Tunnel，不经过本地 HTTP_PROXY。
 */
( (global) {
  'use strict';
  var MSCMS = global.MSCMS || (global.MSCMS = {});

   buildQuery(opts) {
    var p = new URLSearchParams();
    if (opts.query) {
      Object.keys(opts.query).forEach( (k) {
        if (opts.query[k] !== undefined && opts.query[k] !== null) p.set(k, opts.query[k]);
      });
    }
    if (opts.fields && opts.fields.length) p.set('fields', opts.fields.join(','));
    if (opts.page != null) p.set('page', opts.page);
    if (opts.pageSize != null) p.set('pageSize', opts.pageSize);
    if (opts.sort) p.set('sort', opts.sort);
    var s = p.toString();
    return s ? ('?' + s) : '';
  }

   api(method, path, opts) {
    opts = opts || {};
    var url = path + buildQuery(opts);
    var headers = { '': 'application/json', 'X-Client': 'workbench' };
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    var init = { method: method, headers: headers, credentials: 'same-origin' };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;

    return fetch(url, init).then( (res) {
      var isJson = (res.headers.get('') || '').indexOf('application/json') !== -1;
      return (isJson ? res.json() : res.text()).then( (data) {
        if (!res.ok) {
          var msg = (data && data.error) ? data.error : (typeof data === 'string' ? data : res.statusText);
          var err = new Error(msg || ('HTTP ' + res.status));
          err.status = res.status;
          err.body = data;
          throw err;
        }
        // 若后端返回 {total,page,pageSize,items} 分页信封则原样返回
        return data;
      });
    });
  }

  MSCMS.api = {
    get:  (path, opts) { return api('GET', path, opts); },
    post:  (path, body, opts) { return api('POST', path, Object.assign({}, opts, { body: body })); },
    put:  (path, body, opts) { return api('PUT', path, Object.assign({}, opts, { body: body })); },
    del:  (path, opts) { return api('DELETE', path, opts); },
    buildQuery: buildQuery,
    // 分页列表便捷方法：返回 {items, total, page, pageSize}
    paginate:  (path, opts) { return api('GET', path, opts); }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MSCMS.api;
})(typeof window !== 'undefined' ? window : this);
