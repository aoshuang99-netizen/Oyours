/**
 * sensor-simulator.js — MSCMS v14 传感器模拟引擎
 *
 * 核心能力：
 *   1. 6种传感器（加速度计/陀螺仪/磁力计/光线/距离/气压）
 *   2. 实时WebSocket数据推送
 *   3. 仪表盘可视化（实时数值+状态指示）
 *   4. 历史数据曲线图（24h趋势）
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 传感器类型定义 ───────────────────────────────
const SENSOR_TYPES = {
  ACCELEROMETER: {
    id: 'accelerometer',
    name: '加速度计',
    unit: 'm/s²',
    axes: ['x', 'y', 'z'],
    range: [-20, 20],
    noise: 0.05,
    updateRateHz: 100,
  },
  GYROSCOPE: {
    id: 'gyroscope',
    name: '陀螺仪',
    unit: 'rad/s',
    axes: ['x', 'y', 'z'],
    range: [-10, 10],
    noise: 0.01,
    updateRateHz: 100,
  },
  MAGNETOMETER: {
    id: 'magnetometer',
    name: '磁力计',
    unit: 'μT',
    axes: ['x', 'y', 'z'],
    range: [-200, 200],
    noise: 0.5,
    updateRateHz: 50,
  },
  LIGHT: {
    id: 'light',
    name: '光线传感器',
    unit: 'lux',
    axes: null,
    range: [0, 100000],
    noise: 1,
    updateRateHz: 10,
  },
  PROXIMITY: {
    id: 'proximity',
    name: '距离传感器',
    unit: 'cm',
    axes: null,
    range: [0, 15],
    noise: 0.1,
    updateRateHz: 10,
  },
  PRESSURE: {
    id: 'pressure',
    name: '气压传感器',
    unit: 'hPa',
    axes: null,
    range: [800, 1200],
    noise: 0.01,
    updateRateHz: 5,
  },
};

// ── 传感器读数生成器 ─────────────────────────────
class SensorReading {
  constructor(sensorType) {
    this.type = sensorType;
    this.timestamp = Date.now();
    if (sensorType.axes) {
      this.values = {};
      for (const axis of sensorType.axes) {
        this.values[axis] = this._generateBase(sensorType);
      }
    } else {
      this.value = this._generateBase(sensorType);
    }
  }

  _generateBase(sensorType) {
    const [min, max] = sensorType.range;
    const base = min + Math.random() * (max - min);
    // 添加噪声
    return base + (Math.random() - 0.5) * sensorType.noise * (max - min);
  }

  toJSON() {
    return {
      type: this.type.id,
      timestamp: this.timestamp,
      ...(this.values ? { values: this.values } : { value: this.value }),
    };
  }
}

// ── 传感器数据历史 ───────────────────────────────
class SensorHistory {
  constructor(maxEntries = 86400) {
    this.maxEntries = maxEntries;
    this.records = new Map(); // sensorType.id → [{timestamp, value/values}]
    for (const type of Object.values(SENSOR_TYPES)) {
      this.records.set(type.id, []);
    }
  }

  add(sensorReading) {
    const records = this.records.get(sensorReading.type.id);
    if (!records) return;
    records.push(sensorReading.toJSON());
    if (records.length > this.maxEntries) {
      records.splice(0, records.length - this.maxEntries);
    }
  }

  /**
   * 获取指定时间段的历史数据
   */
  getHistory(sensorId, startTime = 0, endTime = Date.now()) {
    const records = this.records.get(sensorId) || [];
    return records.filter(r => r.timestamp >= startTime && r.timestamp <= endTime);
  }

  /**
   * 生成每小时聚合数据（用于曲线图）
   */
  getHourlyAggregation(sensorId, hours = 24) {
    const now = Date.now();
    const startTime = now - hours * 3600000;
    const records = this.getHistory(sensorId, startTime, now);

    if (records.length === 0) return [];

    // 按小时分桶
    const buckets = {};
    for (const r of records) {
      const hour = new Date(r.timestamp).getHours();
      if (!buckets[hour]) {
        buckets[hour] = { count: 0, sum: 0, min: Infinity, max: -Infinity };
      }
      const val = r.value || (r.values ? (r.values.x + r.values.y + r.values.z) / 3 : 0);
      buckets[hour].count++;
      buckets[hour].sum += val;
      buckets[hour].min = Math.min(buckets[hour].min, val);
      buckets[hour].max = Math.max(buckets[hour].max, val);
    }

    return Object.entries(buckets)
      .map(([hour, data]) => ({
        hour: parseInt(hour),
        avg: data.sum / data.count,
        min: data.min,
        max: data.max,
        samples: data.count,
      }))
      .sort((a, b) => a.hour - b.hour);
  }
}

// ── 设备传感器模拟器 ─────────────────────────────
class DeviceSensorSimulator {
  constructor(deviceId, opts = {}) {
    this.deviceId = deviceId;
    this.sensors = {};
    this.intervalIds = {};
    this.history = new SensorHistory();
    this.enabled = new Set(opts.enabledSensors || Object.keys(SENSOR_TYPES));
  }

  /**
   * 启动传感器模拟
   */
  start(sensorTypeIds = null) {
    const types = sensorTypeIds || Array.from(this.enabled);
    for (const typeId of types) {
      const sensorType = SENSOR_TYPES[typeId.toUpperCase()] || Object.values(SENSOR_TYPES).find(s => s.id === typeId);
      if (!sensorType) continue;

      if (this.intervalIds[sensorType.id]) continue; // 已运行

      const intervalMs = 1000 / sensorType.updateRateHz;
      this.intervalIds[sensorType.id] = setInterval(() => {
        const reading = new SensorReading(sensorType);
        this.sensors[sensorType.id] = reading;
        this.history.add(reading);
      }, Math.max(100, intervalMs));
    }
  }

  /**
   * 停止传感器模拟
   */
  stop(sensorTypeIds = null) {
    const types = sensorTypeIds || Array.from(this.enabled);
    for (const typeId of types) {
      const sensorType = Object.values(SENSOR_TYPES).find(s => s.id === typeId);
      if (!sensorType) continue;
      if (this.intervalIds[sensorType.id]) {
        clearInterval(this.intervalIds[sensorType.id]);
        delete this.intervalIds[sensorType.id];
      }
    }
  }

  /**
   * 停止所有传感器
   */
  stopAll() {
    for (const id of Object.keys(this.intervalIds)) {
      clearInterval(this.intervalIds[id]);
    }
    this.intervalIds = {};
  }

  /**
   * 获取当前所有传感器读数
   */
  getCurrentReadings() {
    const readings = {};
    for (const [sensorId, reading] of Object.entries(this.sensors)) {
      readings[sensorId] = reading.toJSON();
    }
    return {
      deviceId: this.deviceId,
      timestamp: Date.now(),
      sensors: readings,
      activeCount: Object.keys(this.intervalIds,
    };
  }

  /**
   * 获取单个传感器最新读数
   */
  getSensorReading(sensorId) {
    const reading = this.sensors[sensorId];
    return reading ? reading.toJSON() : null;
  }
}

// ── 传感器模拟主引擎 ──────────────────────────────
class SensorSimulator extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.devices = new Map(); // deviceId → DeviceSensorSimulator
    this.broadcastInterval = null;
    this.broadcastListeners = new Set();
  }

  /**
   * 为设备注册传感器模拟器
   */
  Device(deviceId, opts = {}) {
    if (this.devices.has(deviceId)) {
      return this.devices.get(deviceId);
    }
    const sim = new DeviceSensorSimulator(deviceId, opts);
    sim.start(); // 默认启动全部传感器
    this.devices.set(deviceId, sim);
    this.emit('deviceRegistered', { deviceId, sensorCount: Object.keys(sim.sensors });
    return sim;
  }

  /**
   * 注销设备
   */
  unDevice(deviceId) {
    const sim = this.devices.get(deviceId);
    if (sim) {
      sim.stopAll();
      this.devices.delete(deviceId);
    }
  }

  /**
   * 获取设备传感器读数
   */
  getDeviceReadings(deviceId) {
    const sim = this.devices.get(deviceId);
    if (!sim) return null;
    return sim.getCurrentReadings();
  }

  /**
   * 获取所有设备读数
   */
  getAllReadings() {
    const all = {};
    for (const [deviceId, sim] of this.devices) {
      all[deviceId] = sim.getCurrentReadings();
    }
    return {
      timestamp: Date.now(),
      deviceCount: this.devices.size,
      readings: all,
    };
  }

  /**
   * 获取设备传感器历史
   */
  getDeviceHistory(deviceId, sensorId, hours = 24) {
    const sim = this.devices.get(deviceId);
    if (!sim) return null;
    return sim.history.getHourlyAggregation(sensorId, hours);
  }

  /**
   * 获取仪表盘数据（实时状态）
   */
  getDashboard() {
    const dashboard = {
      timestamp: Date.now(),
      totalDevices: this.devices.size,
      activeSensors: 0,
      deviceStatuses: [],
      sensorTypeSummary: {},
    };

    for (const sensorType of Object.values(SENSOR_TYPES)) {
      dashboard.sensorTypeSummary[sensorType.id] = {
        name: sensorType.name,
        unit: sensorType.unit,
        deviceCount: 0,
        avgValue: 0,
        totalValues: 0,
      };
    }

    for (const [deviceId, sim] of this.devices) {
      const readings = sim.getCurrentReadings();
      dashboard.activeSensors += readings.activeCount;

      dashboard.deviceStatuses.push({
        deviceId,
        activeSensors: readings.activeCount,
        sensorIds: Object.keys(readings.sensors),
      });

      for (const [sensorId, reading] of Object.entries(readings.sensors)) {
        const summary = dashboard.sensorTypeSummary[sensorId];
        if (summary) {
          summary.deviceCount++;
          const val = reading.value !== undefined ? reading.value
            : (reading.values ? (reading.values.x + reading.values.y + reading.values.z) / 3 : 0);
          summary.totalValues += val;
        }
      }
    }

    // 计算平均值
    for (const key of Object.keys(dashboard.sensorTypeSummary)) {
      const summary = dashboard.sensorTypeSummary[key];
      if (summary.deviceCount > 0) {
        summary.avgValue = Math.round(summary.totalValues / summary.deviceCount * 100) / 100;
      }
    }

    return dashboard;
  }

  /**
   * 启动实时广播
   */
  startBroadcast(intervalMs = 1000) {
    if (this.broadcastInterval) return;
    this.broadcastInterval = setInterval(() => {
      const data = this.getAllReadings();
      this.emit('sensorData', data);
      for (const listener of this.broadcastListeners) {
        try { listener(data); } catch {}
      }
    }, intervalMs);
  }

  /**
   * 停止广播
   */
  stopBroadcast() {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  /**
   * 注册广播监听器
   */
  onBroadcast(callback) {
    this.broadcastListeners.add(callback);
    return () => this.broadcastListeners.delete(callback);
  }

  /**
   * 注册全部50台设备
   */
  All(targetCount = 50) {
    const results = [];
    for (let i = 1; i <= targetCount; i++) {
      const sim = this.Device(i);
      results.push({ deviceId: i, sensorCount: Object.keys(sim.sensors });
    }
    return results;
  }
}

module.exports = {
  SensorSimulator,
  DeviceSensorSimulator,
  SensorReading,
  SensorHistory,
  SENSOR_TYPES,
};
