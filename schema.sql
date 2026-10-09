CREATE DATABASE IF NOT EXISTS affiliate_system DEFAULT CHARACTER SET utf8mb4;
USE affiliate_system;

CREATE TABLE `traffic_` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `bot_id` VARCHAR(50) NOT NULL UNIQUE,
  `` ENUM('X', 'Reddit', 'Instagram', 'TikTok') NOT NULL,
  `proxy_server` VARCHAR(255) NOT NULL,
  `bound_country` VARCHAR(10) DEFAULT 'US',
  `cookies_blob` LONGTEXT,
  `status` ENUM('active', 'warming', 'shadowbanned', 'dead') DEFAULT 'warming',
  `weight` INT DEFAULT 100,
  `total_clicks` INT DEFAULT 0,
  `total_conversions` INT DEFAULT 0,
  `last_used_at` TIMESTAMP NULL DEFAULT NULL,
  `` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `traffic_conversions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `click_id` VARCHAR(64) NOT NULL UNIQUE,
  `bot_id` VARCHAR(50) NOT NULL,
  `post_id` INT NOT NULL,
  `` ENUM('X', 'Reddit', 'Instagram', 'TikTok') NOT NULL,
  `user_ip` VARCHAR(45) NOT NULL,
  `user_agent` TEXT NOT NULL,
  `is_converted` TINYINT(1) DEFAULT 0,
  `payout` DECIMAL(10,2) DEFAULT 0.00,
  `clicked_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `converted_at` TIMESTAMP NULL DEFAULT NULL,
  FOREIGN KEY (`bot_id`) REFERENCES `traffic_`(`bot_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
