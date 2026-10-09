/**
 * workbench/ws-events.js — MSCMS v14 统一 WebSocket 实时事件客户端
 * 设计依据：dev_design_tasks.html §3 WS 事件协议（topic 订阅 + 重连心跳）
 * 取代前端 3s 轮询：后端 /ws/v14 广播以下 topic（M2 后端扩展阶段接入 server.js）：
 *   account | publish | inbox | monitor | competitor | kpi | system | causal
 * - 自动重连（指数退避，上限 30s）+ 25s 心跳 ping/pong
 * - subscribe(topic, cb) 支持多订阅者；消息按 topic 路由分发
 * - 零依赖、UMD 风格，挂全局 MSCMS.ws
 */
( (global) {
  'use strict';
  var MSCMS = global.MSCMS || (global.MSCMS = {});

  var TOPICS = ['account', 'publish', 'inbox', 'monitor', 'competitor', 'kpi', 'system', 'causal'];

   connect(opts) {
    opts = opts || {};
    var proto = (location.protocol === 'https:') ? 'wss://' : 'ws://';
    var url = opts.url || (proto + location.host + '/ws/v14');
    var onMessage = opts.onMessage ||  () {};
    var onStatus = opts.onStatus ||  () {};

    var ws = null;
    var retry = 0;
    var reconnectTimer = null;
    var heartbeat = null;
    var subs = {};        // topic -> [cb]
    var anySubs = [];     // 全局监听

     dispatch(msg) {
      if (msg && msg.topic && subs[msg.topic]) {
        subs[msg.topic].forEach( (cb) { try { cb(msg); } catch (e) { console.error('[ws] sub err', e); } });
      }
      anySubs.forEach( (cb) { try { cb(msg); } catch (e) {} });
    }

     open() {
      try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
      ws.onopen =  () {
        retry = 0;
        onStatus('open');
        // 心跳
        heartbeat = setInterval( () {
          if (ws && ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch (e) {}
          }
        }, 25000);
      };
      ws.onmessage =  (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (!m) return;
        if (m.type === 'pong') return;
        onMessage(m);
        dispatch(m);
      };
      ws.onclose =  () {
        onStatus('closed');
        if (heartbeat) clearInterval(heartbeat);
        scheduleReconnect();
      };
      ws.onerror =  () { try { ws.close(); } catch (e) {} };
    }

     scheduleReconnect() {
      var delay = Math.min(30000, 1000 * Math.pow(2, retry));
      retry++;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(open, delay);
    }

     subscribe(topic, cb) {
      if (TOPICS.indexOf(topic) === -1) console.warn('[ws] 未知 topic:', topic);
      (subs[topic] = subs[topic] || []).push(cb);
      return  unsubscribe() {
        subs[topic] = (subs[topic] || []).filter( (f) { return f !== cb; });
      };
    }

     onAny(cb) { anySubs.push(cb); return  () { anySubs = anySubs.filter( (f) { return f !== cb; }); }; }

     send(obj) {
      if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
      return false;
    }

     close() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeat) clearInterval(heartbeat);
      if (ws) try { ws.close(); } catch (e) {}
    }

    open();
    return { subscribe: subscribe, onAny: onAny, send: send, close: close, TOPICS: TOPICS };
  }

  MSCMS.ws = { connect: connect, TOPICS: TOPICS };
  if (typeof module !== 'undefined' && module.exports) module.exports = MSCMS.ws;
})(typeof window !== 'undefined' ? window : this);
