/**
 * gps-trajectory.js — MSCMS v14 GPS轨迹模拟引擎
 *
 * 核心能力：
 *   1. 多路径点编辑（经纬度+海拔+速度+停留时间）
 *   2. Bezier曲线平滑插值（三次贝塞尔，生成自然运动轨迹）
 *   3. 多速度模型（步行/骑行/驾车/高铁）
 *   4. 设备间错时启动（随机偏移，防止批量关联）
 *   5. 轨迹回放与验证
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 速度模型（km/h → m/s）─────────────────────
const SPEED_MODELS = {
  walking:    { name: '步行',    minKmh: 3,  maxKmh: 6,   jitter: 0.5,  pauseChance: 0.15, pauseDuration: [10, 60] },
  cycling:    { name: '骑行',    minKmh: 10, maxKmh: 25,  jitter: 2,    pauseChance: 0.05, pauseDuration: [5, 30] },
  driving:    { name: '驾车',    minKmh: 30, maxKmh: 80,  jitter: 8,    pauseChance: 0.03, pauseDuration: [30, 300] },
  high_speed: { name: '高铁',    minKmh: 200,maxKmh: 350, jitter: 15,   pauseChance: 0.0,  pauseDuration: [0, 0] },
};

// ── Bezier 曲线工具 ─────────────────────────────
class BezierCurve {
  /**
   * 三次贝塞尔插值: B(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃
   */
  static cubicBezier(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return {
      lat: u*u*u * p0.lat + 3*u*u*t * p1.lat + 3*u*t*t * p2.lat + t*t*t * p3.lat,
      lng: u*u*u * p0.lng + 3*u*u*t * p1.lng + 3*u*t*t * p2.lng + t*t*t * p3.lng,
      alt: u*u*u * p0.alt + 3*u*u*t * p1.alt + 3*u*t*t * p2.alt + t*t*t * p3.alt,
    };
  }

  /**
   * 为一组控制点生成控制柄（自动计算合理的控制点）
   */
  static autoControlPoints(points, tension = 0.3) {
    const cps = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p3 = points[i + 1];
      const dx = p3.lng - p0.lng;
      const dy = p3.lat - p0.lat;
      const dz = (p3.alt || 0) - (p0.alt || 0);
      cps.push({
        p0, p3,
        p1: { lat: p0.lat + dy * tension, lng: p0.lng + dx * tension, alt: (p0.alt || 0) + dz * tension },
        p2: { lat: p3.lat - dy * tension, lng: p3.lng - dx * tension, alt: (p3.alt || 0) - dz * tension },
      });
    }
    return cps;
  }
}

// ── 路径点定义 ───────────────────────────────────
class Waypoint {
  constructor(opts = {}) {
    this.lat = opts.lat || 0;          // 纬度
    this.lng = opts.lng || 0;          // 经度
    this.alt = opts.alt || 0;          // 海拔（米）
    this.speed = opts.speed || 30;     // 建议速度（km/h）
    this.stayMs = opts.stayMs || 0;    // 停留时间（毫秒）
    this.label = opts.label || '';     // 标签
    this.accuracy = opts.accuracy || 5; // GPS精度（米）
  }
}

// ── 轨迹路径 ─────────────────────────────────────
class TrajectoryPath {
  constructor(id, opts = {}) {
    this.id = id;
    this.name = opts.name || '轨迹';
    this.waypoints = [];
    this.speedModel = opts.speedModel || 'driving';
    this.interpolation = opts.interpolation || 'bezier';
    this.samplesPerSegment = opts.samplesPerSegment || 50;
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
  }

  addWaypoint(wp) {
    this.waypoints.push(wp instanceof Waypoint ? wp : new Waypoint(wp));
    this.updatedAt = new Date().toISOString();
  }

  removeWaypoint(index) {
    this.waypoints.splice(index, 1);
    this.updatedAt = new Date().toISOString();
  }

  updateWaypoint(index, updates) {
    Object.assign(this.waypoints[index], updates);
    this.updatedAt = new Date().toISOString();
  }

  /**
   * 生成平滑轨迹点序列
   * 返回: [{lat, lng, alt, speed, timestamp, accuracy}, ...]
   */
  generate(deviceStartTime = null) {
    if (this.waypoints.length < 2) {
      return [];
    }

    const model = SPEED_MODELS[this.speedModel] || SPEED_MODELS.driving;
    const controlSegments = BezierCurve.autoControlPoints(this.waypoints);
    const fullPath = [];
    let currentTime = deviceStartTime || Date.now();

    for (let segIdx = 0; segIdx < controlSegments.length; segIdx++) {
      const seg = controlSegments[segIdx];

      // 计算首段距离
      const distanceKm = this._haversineDistance(seg.p0, seg.p3);
      const baseSpeed = this._sampleSpeed(seg.p0, seg.p3, model);

      for (let s = 0; s < this.samplesPerSegment; s++) {
        const t = s / this.samplesPerSegment;
        const point = BezierCurve.cubicBezier(seg.p0, seg.p1, seg.p2, seg.p3, t);

        // 速度 jitter
        const jitteredSpeed = baseSpeed + (Math.random() - 0.5) * model.jitter * 2;
        const speedMs = jitteredSpeed / 3.6;

        // 时间推进
        const segmentDistKm = distanceKm / this.samplesPerSegment;
        const dtSec = (segmentDistKm / (jitteredSpeed || 1)) * 3600;
        currentTime += Math.max(0.5, dtSec) * 1000;

        // 随机暂停
        if (Math.random() < model.pauseChance) {
          const pauseMs = this._randomRange(model.pauseDuration[0], model.pauseDuration[1]) * 1000;
          currentTime += pauseMs;
        }

        fullPath.push({
          lat: point.lat,
          lng: point.lng,
          alt: point.alt,
          speed: jitteredSpeed,
          timestamp: new Date(currentTime).toISOString(),
          accuracy: this.waypoints[0].accuracy + (Math.random() - 0.5) * 3,
          segmentIndex: segIdx,
        });
      }

      // 停留时间
      if (segIdx < this.waypoints.length - 1) {
        const wp = this.waypoints[segIdx + 1];
        if (wp.stayMs > 0) {
          currentTime += wp.stayMs;
        }
      }
    }

    return fullPath;
  }

  _haversineDistance(p1, p2) {
    const R = 6371;
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(p1.lat*Math.PI/180) * Math.cos(p2.lat*Math.PI/180) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  _sampleSpeed(wp1, wp2, model) {
    const wpSpeed = (wp1.speed + wp2.speed) / 2;
    return wpSpeed > 0 ? Math.min(wpSpeed, model.maxKmh) : this._randomRange(model.minKmh, model.maxKmh);
  }

  _randomRange(min, max) {
    return min + Math.random() * (max - min);
  }
}

// ── 设备错时启动管理器 ─────────────────────────
class StaggeredLauncher {
  constructor(opts = {}) {
    this.baseDelayMs = opts.baseDelayMs || 5000;   // 基础间隔 5秒
    this.randomRangeMs = opts.randomRangeMs || 15000; // 随机范围 ±15秒
  }

  /**
   * 为N台设备生成错时启动时间表
   */
  generateSchedule(deviceCount, startTime = null) {
    const base = startTime || Date.now();
    const schedule = [];

    for (let i = 0; i < deviceCount; i++) {
      const randomOffset = (Math.random() - 0.5) * this.randomRangeMs;
      const staggerMs = i * this.baseDelayMs + randomOffset;
      schedule.push({
        deviceIndex: i,
        startTime: new Date(base + staggerMs).toISOString(),
        offsetMs: staggerMs,
      });
    }

    return schedule;
  }
}

// ── 主要引擎 ─────────────────────────────────────
class GPSTrajectoryEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.paths = new Map();
    this.activeTrajectories = new Map(); // deviceId → trajectory state
    this.staggeredLauncher = new StaggeredLauncher(opts.stagger || {});
    this.presets = this._initPresets();
  }

  _initPresets() {
    return {
      city_walk: {
        name: '城市步行',
        speedModel: 'walking',
        waypoints: [
          { lat: 40.7128, lng: -74.0060, label: '起点-时代广场' },
          { lat: 40.7142, lng: -74.0025, label: '洛克菲勒中心' },
          { lat: 40.7157, lng: -74.0000, label: '中央公园' },
        ],
      },
      commute: {
        name: '通勤路线',
        speedModel: 'driving',
        waypoints: [
          { lat: 37.7749, lng: -122.4194, label: '旧金山', stayMs: 60000 },
          { lat: 37.4419, lng: -122.1430, label: '帕洛阿尔托', stayMs: 30000 },
          { lat: 37.3352, lng: -121.8811, label: '圣何塞' },
        ],
      },
      country_tour: {
        name: '郊区骑行',
        speedModel: 'cycling',
        waypoints: [
          { lat: 48.8566, lng: 2.3522, label: '巴黎市中心' },
          { lat: 48.8738, lng: 2.2950, label: '凯旋门' },
          { lat: 48.8867, lng: 2.3431, label: '蒙马特高地' },
        ],
      },
      intercity: {
        name: '城际穿梭',
        speedModel: 'high_speed',
        waypoints: [
          { lat: 35.6762, lng: 139.6503, label: '东京' },
          { lat: 34.6937, lng: 135.5023, label: '大阪' },
          { lat: 35.0116, lng: 135.7681, label: '京都' },
        ],
      },
    };
  }

  /**
   * 创建新轨迹
   */
  createPath(name, speedModel, waypoints) {
    const id = `traj_${Date.now()}_${crypto.randomBytes(3'hex')}`;
    const path = new TrajectoryPath(id, { name, speedModel });
    for (const wp of waypoints) {
      path.addWaypoint(wp);
    }
    this.paths.set(id, path);
    this.emit('pathCreated', { id, name });
    return path;
  }

  /**
   * 从预设创建
   */
  createFromPreset(presetName, customName = null) {
    const preset = this.presets[presetName];
    if (!preset) throw new Error(`未知预设: ${presetName}`);

    return this.createPath(
      customName || preset.name,
      preset.speedModel,
      preset.waypoints
    );
  }

  /**
   * 获取路径
   */
  getPath(id) {
    return this.paths.get(id) || null;
  }

  /**
   * 列出所有路径
   */
  listPaths() {
    return Array.from(this.paths.values()).map(p => ({
      id: p.id,
      name: p.name,
      speedModel: p.speedModel,
      waypointCount: p.waypoints.length,
      createdAt: p.createdAt,
    }));
  }

  /**
   * 为设备启动GPS轨迹模拟
   */
  startForDevice(deviceId, pathId, opts = {}) {
    const path = this.paths.get(pathId);
    if (!path) throw new Error(`路径不存在: ${pathId}`);

    const startTime = opts.startTime ? new Date(opts.startTime).getTime() : null;
    const points = path.generate(startTime);

    this.activeTrajectories.set(deviceId, {
      pathId,
      points,
      currentIndex: 0,
      startedAt: new Date().toISOString(),
      status: 'running',
      loopMode: opts.loop || false,
    });

    this.emit('trajectoryStarted', { deviceId, pathId, totalPoints: points.length });
    return { deviceId, totalPoints: points.length, startedAt: new Date().toISOString() };
  }

  /**
   * 批量错时启动
   */
  batchStart(deviceIds, pathId, opts = {}) {
    const schedule = this.staggeredLauncher.generateSchedule(deviceIds.length);
    const results = [];

    for (const item of schedule) {
      const deviceId = deviceIds[item.deviceIndex];
      if (deviceId) {
        const r = this.startForDevice(deviceId, pathId, {
          ...opts,
          startTime: item.startTime,
        });
        results.push({ ...r, deviceId, scheduledStart: item.startTime, offsetMs: item.offsetMs });
      }
    }

    return results;
  }

  /**
   * 获取设备当前位置
   */
  getCurrentPosition(deviceId) {
    const traj = this.activeTrajectories.get(deviceId);
    if (!traj) return null;

    const point = traj.points[traj.currentIndex];
    if (!point) return null;

    return {
      ...point,
      deviceId,
      progress: ((traj.currentIndex / traj.points.length) * 100).toFixed(1),
      remaining: traj.points.length - traj.currentIndex,
    };
  }

  /**
   * 推进设备到下一个位置点
   */
  advanceDevice(deviceId) {
    const traj = this.activeTrajectories.get(deviceId);
    if (!traj) return null;

    traj.currentIndex++;
    if (traj.currentIndex >= traj.points.length) {
      if (traj.loopMode) {
        traj.currentIndex = 0;
      } else {
        traj.status = 'completed';
        this.emit('trajectoryCompleted', { deviceId, pathId: traj.pathId });
        return { ...traj.points[traj.points.length - 1], status: 'completed' };
      }
    }

    return { ...traj.points[traj.currentIndex], status: traj.status };
  }

  /**
   * 停止设备GPS
   */
  stopForDevice(deviceId) {
    const traj = this.activeTrajectories.get(deviceId);
    if (traj) {
      traj.status = 'stopped';
      this.activeTrajectories.delete(deviceId);
      this.emit('trajectoryStopped', { deviceId });
    }
  }

  /**
   * 获取所有活跃轨迹状态
   */
  getActiveStatus() {
    const status = [];
    for (const [deviceId, traj] of this.activeTrajectories) {
      status.push({
        deviceId,
        pathId: traj.pathId,
        status: traj.status,
        progress: `${traj.currentIndex}/${traj.points.length}`,
        percent: ((traj.currentIndex / traj.points.length) * 100).toFixed(1),
        startedAt: traj.startedAt,
      });
    }
    return status;
  }
}

module.exports = {
  GPSTrajectoryEngine,
  TrajectoryPath,
  Waypoint,
  BezierCurve,
  StaggeredLauncher,
  SPEED_MODELS,
};
