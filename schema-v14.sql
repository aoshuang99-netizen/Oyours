-- ============================================================================
-- schema-v14.sql — MSCMS v14 数据库 Schema 扩展
-- 在现有 affiliate_system 库基础上新增 v14 表
-- ============================================================================

-- 1. 云手机设备表
CREATE TABLE IF NOT EXISTS cloud_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    idx INT NOT NULL UNIQUE COMMENT '设备编号 1-50',
    avd_name VARCHAR(100) NOT NULL COMMENT '设备名称 phone-001',
    adb_serial VARCHAR(200) COMMENT 'ADB序列号',
    device_template VARCHAR(100) COMMENT '设备模板型号',
    status VARCHAR(30) DEFAULT 'offline' COMMENT 'offline|starting|booting|online|ready|busy|error',
    mode VARCHAR(20) DEFAULT 'browser' COMMENT 'emulator|browser',
    proxy JSON COMMENT '代理配置 {host,port,type,country}',
    fingerprinted TINYINT DEFAULT 0 COMMENT '是否已注入指纹',
    fingerprint_version INT DEFAULT 1,
    sensor_data JSON COMMENT '传感器数据',
     INT DEFAULT 100 COMMENT '健康评分 0-100',
    restarts INT DEFAULT 0 COMMENT '重启次数',
    boot_time_ms INT DEFAULT 0 COMMENT '启动耗时(ms)',
    last_online DATETIME,
     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status),
    INDEX idx_mode (mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 指纹表
CREATE TABLE IF NOT EXISTS device_fingerprints (
    id INT AUTO_INCREMENT PRIMARY KEY,
    device_id INT NOT NULL COMMENT 'cloud_devices.id',
    imei1 VARCHAR(20) NOT NULL,
    imei2 VARCHAR(20),
    imsi VARCHAR(20),
    android_id VARCHAR(20) NOT NULL,
    wifi_mac VARCHAR(20),
    bt_mac VARCHAR(20),
    serial_no VARCHAR(100),
    manufacturer VARCHAR(50),
    model VARCHAR(50),
    build_fingerprint VARCHAR(500),
    country_code VARCHAR(5) DEFAULT 'US',
    timezone VARCHAR(50) DEFAULT 'America/New_York',
    locale VARCHAR(10) DEFAULT 'en-US',
    version INT DEFAULT 1 COMMENT '版本号',
    verified TINYINT DEFAULT 0 COMMENT '是否验证通过',
    injected_at DATETIME,
     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES cloud_devices(id) ON DELETE CASCADE,
    UNIQUE KEY uk_device_version (device_id, version),
    INDEX idx_imei (imei1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. 社媒账号表（v14扩展）
CREATE TABLE IF NOT EXISTS social__v14 (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id VARCHAR(50) NOT NULL UNIQUE COMMENT '账号ID acct_xxx',
     VARCHAR(30) NOT NULL COMMENT 'tiktok|instagram|facebook|twitter|youtube',
     VARCHAR(200) NOT NULL,
    email VARCHAR(200),
    device_id INT COMMENT '绑定设备ID',
    proxy_id INT,
    tier VARCHAR(20) DEFAULT 'T0_NEW' COMMENT 'T0-T6',
    state VARCHAR(30) DEFAULT '' COMMENT 'S0-S6',
     DECIMAL(5,2) DEFAULT 0 COMMENT '健康分数 0-100',
     DECIMAL(5,2) DEFAULT 0 COMMENT '封号风险 0-100',
     INT DEFAULT 0 COMMENT '养号天数',
    warming_start DATETIME COMMENT '养号开始时间',
    graduated_at DATETIME COMMENT '养成完成时间',
    total_actions INT DEFAULT 0 COMMENT '总操作数',
    followers INT DEFAULT 0,
    following INT DEFAULT 0,
    posts INT DEFAULT 0,
    total_likes INT DEFAULT 0,
    total_comments INT DEFAULT 0,
    last_active_at DATETIME,
    dormant_days INT DEFAULT 0 COMMENT '静默天数',
     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES cloud_devices(id) ON DELETE SET NULL,
    INDEX idx__state (, state),
    INDEX idx_tier (tier),
    INDEX idx_risk ()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. 养号操作日志
CREATE TABLE IF NOT EXISTS nurturing_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id VARCHAR(50) NOT NULL,
    device_id INT,
    action_type VARCHAR(50) NOT NULL COMMENT 'browse|like|follow|comment|share|post|watch|subscribe',
    action_detail JSON COMMENT '操作详情',
    delay_ms INT COMMENT '延迟毫秒',
    risk_score DECIMAL(5,2) DEFAULT 0,
    tier_at_time VARCHAR(10),
    state_at_time VARCHAR(20),
    success TINYINT DEFAULT 1,
    error_message TEXT,
     DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_account_time (account_id, ),
    INDEX idx_action_type (action_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. 内容DNA模板表
CREATE TABLE IF NOT EXISTS content_dna (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dna_id VARCHAR(50) NOT NULL UNIQUE,
    topic_keywords JSON COMMENT '关键词列表',
    category VARCHAR(50),
    format_type VARCHAR(30) COMMENT 'image_text|short_video|long_video|carousel',
    topic_dna JSON COMMENT '主题DNA',
    format_dna JSON COMMENT '格式DNA',
    structure_dna JSON COMMENT '结构DNA',
    variation_params JSON COMMENT '变异参数',
    viral_score DECIMAL(5,2) DEFAULT 0,
    total_views INT DEFAULT 0,
    total_likes INT DEFAULT 0,
    total_shares INT DEFAULT 0,
    total_comments INT DEFAULT 0,
    clone_count INT DEFAULT 0 COMMENT '已生成变体数',
    source_hot_topic_id INT COMMENT '来源热点ID',
     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_viral (viral_score),
    INDEX idx_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. 内容变体表
CREATE TABLE IF NOT EXISTS content_variants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    variant_id VARCHAR(50) NOT NULL UNIQUE,
    parent_dna_id VARCHAR(50),
    generation_level INT DEFAULT 1 COMMENT 'L1-L5生成层级',
    variation_intensity DECIMAL(3,2) DEFAULT 0.5,
    original_text TEXT,
    variant_text TEXT,
    media_urls JSON COMMENT '媒体文件URL列表',
    hashtags JSON,
     VARCHAR(30),
    jaccard_similarity DECIMAL(4,3) COMMENT '与原内容的Jaccard相似度',
    levenshtein_ratio DECIMAL(4,3) COMMENT 'Levenshtein距离比',
    quality_score DECIMAL(5,2) DEFAULT 0 COMMENT '质量评分',
    published TINYINT DEFAULT 0,
    published_at DATETIME,
    published_to_ JSON COMMENT '已发布到哪些账号',
     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_dna_id) REFERENCES content_dna(dna_id) ON DELETE SET NULL,
    INDEX idx_dna (parent_dna_id),
    INDEX idx_ (),
    INDEX idx_published (published)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. 发布日志表
CREATE TABLE IF NOT EXISTS publish_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    variant_id VARCHAR(50),
    account_id VARCHAR(50),
     VARCHAR(30),
    device_id INT,
    content_type VARCHAR(30),
    content_hash VARCHAR(64),
    publish_status VARCHAR(20) DEFAULT 'pending' COMMENT 'pending|published|failed|retrying',
    publish_time DATETIME,
    schedule_time DATETIME COMMENT '预定的发布时间',
    retry_count INT DEFAULT 0,
    error_message TEXT,
     DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_account_time (account_id, publish_time),
    INDEX idx_status (publish_status),
    INDEX idx_schedule (schedule_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. 性能指标表
CREATE TABLE IF NOT EXISTS performance_metrics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    variant_id VARCHAR(50),
    account_id VARCHAR(50),
     VARCHAR(30),
    metric_type VARCHAR(30) COMMENT 'traffic|engagement|conversion|retention|growth|sentiment',
    metric_name VARCHAR(50) COMMENT 'views|likes|shares|comments|follows|clicks',
    metric_value DECIMAL(15,2) DEFAULT 0,
    collection_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    interval_type VARCHAR(10) COMMENT '1min|5min|15min|1h|6h|24h',
    INDEX idx_variant_time (variant_id, collection_time),
    INDEX idx_account_metric (account_id, metric_name),
    INDEX idx_interval (interval_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. 病毒信号表
CREATE TABLE IF NOT EXISTS viral_signals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    variant_id VARCHAR(50),
    account_id VARCHAR(50),
    signal_type VARCHAR(50) COMMENT 'ml_prediction|data_explosion|social_signal|competitor_signal',
    signal_score DECIMAL(5,2),
    signal_source JSON COMMENT '信号来源详情',
    detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confidence DECIMAL(4,3) DEFAULT 0.5,
    action_taken VARCHAR(50) COMMENT 'clone|amplify|monitor|ignore',
    action_detail JSON,
    INDEX idx_variant_signal (variant_id, signal_type),
    INDEX idx_detected (detected_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. 自进化策略表
CREATE TABLE IF NOT EXISTS _evolution (
    id INT AUTO_INCREMENT PRIMARY KEY,
    _type VARCHAR(50) COMMENT 'style|timing|variation|sync|_algorithm',
    account_id VARCHAR(50),
     VARCHAR(30),
    parameter_name VARCHAR(100),
    old_value JSON,
    new_value JSON,
    improvement_pct DECIMAL(6,3) COMMENT '改进百分比',
    confidence DECIMAL(4,3) DEFAULT 0.5,
    applied TINYINT DEFAULT 0,
    applied_at DATETIME,
     DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ (_type, ),
    INDEX idx_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 11. 热点话题缓存表
CREATE TABLE IF NOT EXISTS hot_topics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    topic_id VARCHAR(50) NOT NULL UNIQUE,
    source VARCHAR(50) COMMENT '数据源',
     VARCHAR(30),
    title TEXT,
    keywords JSON,
    hot_score DECIMAL(5,2) DEFAULT 0,
    hot_level VARCHAR(5) COMMENT 'S|A|B|C',
    engagement JSON COMMENT '互动数据',
    growth_rate DECIMAL(6,3),
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expired TINYINT DEFAULT 0 COMMENT '是否过期',
    INDEX idx_hot_score (hot_score DESC),
    INDEX idx_level (hot_level),
    INDEX idx_ ()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 12. 跨账号同步事件表
CREATE TABLE IF NOT EXISTS sync_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_type VARCHAR(30) COMMENT 'T1|T2|T3 触发级别',
    source_content_id VARCHAR(50),
    source_account_id VARCHAR(50),
    target_account_ids JSON COMMENT '目标账号列表',
    sync_level INT COMMENT '同步级别 1-3',
    variation_count INT DEFAULT 0,
    success_count INT DEFAULT 0,
    fail_count INT DEFAULT 0,
    completed_at DATETIME,
     DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_source (source_content_id),
    INDEX idx_event_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
